#!/bin/bash

# set -x
set -eu -o pipefail
bash --version
jq --version

# To run:
#  1. Generate a Gitlab Personal Access Token
#     (https://gitlab.invenia.ca/profile/personal_access_tokens)
#     selecting the `read_api` scope
#  2. Run:
#   export GITLAB_ACCESS_TOKEN=<token>
#   ./download_pipelines_info.sh

MAX_N_PROJECTS=100000
MAX_N_PIPELINES=30
echo "MAX_N_PROJECTS=$MAX_N_PROJECTS"
echo "MAX_N_PIPELINES=$MAX_N_PIPELINES"

mkdir -p responses/projects/

curl_wrapper() {
    output=$(curl --silent "$@")
    if jq -e . >/dev/null 2>&1 <<<"$output"; then
        # Parsed JSON successfully
        # Now check for any error field
        has_error=$(echo "$output" | jq 'type == "object" and has("error")')
        if [[ "$has_error" = "true" ]]; then
            echo "Error in Gitlab API response" >&2
            url=${@:$#} # last argument of $@
            echo "URL: $url" >&2
            echo $output >&2
            exit 1
        fi
    fi
    # echo "NO ERROR" >&2
    echo "$output" # quotes are important, otherwise newlines will be removed
}


download_project_list() {
    echo "Downloading project list"
    project_query="https://gitlab.invenia.ca/api/v4/groups/invenia/projects?archived=false&include_subgroups=true&per_page=100"
    curl_wrapper --dump-header responses/projects/head -H "Private-Token: $GITLAB_ACCESS_TOKEN" "$project_query" > /dev/null

    # n_projects=$(cat responses/projects/head | grep X-Total: | sed 's/[^0-9]*//g')
    n_pages=$(cat responses/projects/head | grep X-Total-Pages: | sed 's/[^0-9]*//g')
    echo "Total pages for project list: $n_pages"

    for (( page = 1; page <= $n_pages; page++ )); do
        echo "page $page"
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "$project_query&page=$page" > responses/projects/page_$page.json
    done
    # jq -s '.|flatten|length' responses/projects/*.json
}

download_project_list

echo "Downloading projects"

project_ids=($(jq -s '[. | flatten | .[] | select(.archived==false)] | map(.id|tostring) | join(" ")' responses/projects/*.json -r))
# project_ids=(241 460 353 201 473 508 533 536) # (BidFiles.jl GLMForecasters.jl GPForecasters.jl S3DB.jl Backruns.jl Features.jl GLMModels.jl<rse> WrapperModels.jl<rse>)
# project_ids=(473 508 533 536) # (Backruns.jl Features.jl GLMModels.jl<rse> WrapperModels.jl<rse>)

project_ids=("${project_ids[@]:0:$MAX_N_PROJECTS}")

nightly_users=(nightly-dev nightly-rse)


combined_json_file=public/combined.json
combined_small_json_file=public/combined_small.json
echo '[' > $combined_json_file

first_iteration=true
# for project_id in ${project_ids[@]}; do
for i in "${!project_ids[@]}"; do
    project_id="${project_ids[$i]}"
    echo "Downloading info for project $project_id [$((i+1))/${#project_ids[@]}]"
    # Hack to add commas between json array elements
    if [[ $first_iteration = true ]]; then first_iteration=false; else echo "," >> $combined_json_file; fi

    echo '{' >> $combined_json_file

    mkdir -p responses/projects/$project_id/pipelines/{by_user,by_id}
    curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id" > responses/projects/$project_id/project.json
    echo '"metadata":' >> $combined_json_file
    cat responses/projects/$project_id/project.json >> $combined_json_file
    project_name=$(jq '.name_with_namespace' responses/projects/$project_id/project.json -r)
    web_url=$(jq '.web_url' responses/projects/$project_id/project.json -r)
    echo " Project name: '$project_name' ($web_url)"

    # Will get only the first 20 issues (`/issues` is paginated but we don't paginate for simplicity here)
    curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/issues?labels=nightly&state=opened" > responses/projects/$project_id/issues.json
    echo ',"issues":' >> $combined_json_file
    cat responses/projects/$project_id/issues.json \
        | jq -c '[.[] | {ref: .references.short, title:.title, web_url:.web_url, created_at:.created_at, updated_at:.updated_at}]' \
        >> $combined_json_file

    for nightly_user in ${nightly_users[@]}; do
        mkdir -p responses/projects/$project_id/pipelines/by_user/$nightly_user
        url="https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines?username=${nightly_user}&per_page=$MAX_N_PIPELINES"
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "$url" > responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json
        if [[ $(< responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json) = '{"message":"403 Forbidden"}' ]]; then
            echo '[]' > responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json
            echo " Got a 403 Forbidden for $url (this is likely ok, some repos don't allow access to CI)"
        fi
        num_pipelines=$(jq 'length' responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json)
        # echo $num_pipelines
        if [[ $num_pipelines -gt 0 ]]; then
            echo ',"nightly_user":"'$nightly_user'"' >> $combined_json_file
        fi
    done
    echo ',"pipelines":' >> $combined_json_file
    jq -s '.|flatten' responses/projects/$project_id/pipelines/by_user/*/*.json -r >> $combined_json_file

    # pipeline status is one of: created, waiting_for_resource, preparing, pending, running, success, failed, canceled, skipped, manual, scheduled 
    pipeline_ids=$(jq -s '[. | flatten | .[]] | sort_by(.created_at) | [.[].id | tostring] | join(" ")' responses/projects/$project_id/pipelines/by_user/*/*.json -r)
    echo ',"pipeline_jobs":{' >> $combined_json_file

    echo "pipeline_ids: [$pipeline_ids]"
    if [[ -z "$pipeline_ids" ]]; then
        echo "WARN: no pipelines for project_id=$project_id"
        echo '}' >> $combined_json_file # pipeline_jobs
        echo '}' >> $combined_json_file # project
        continue
    fi

    pipeline_ids=($pipeline_ids) # to array
    first_iteration_inner_loop=true
    for pipeline_id in ${pipeline_ids[@]}; do
        # Hack to add commas between json array elements
        if [[ $first_iteration_inner_loop = true ]]; then first_iteration_inner_loop=false; else echo "," >> $combined_json_file; fi

        mkdir -p responses/projects/$project_id/pipelines/by_id/$pipeline_id/
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines/$pipeline_id/jobs" > responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json
        
        echo "\"$pipeline_id\":{" >> $combined_json_file
        echo '"jobs":' >> $combined_json_file
        cat responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json >> $combined_json_file

        # job status is one of: success, failed, skipped, canceled, manual (others?)
        # Save failed_job_names.json (for downloading job logs further down)
        jq -s '[. | flatten | .[] | select(.status=="failed") | .name | tostring]' \
            responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json -r \
            > responses/projects/$project_id/pipelines/by_id/$pipeline_id/failed_job_names.json

        echo '}' >> $combined_json_file # pipeline_id
    done

    echo '}' >> $combined_json_file # pipeline_jobs
    echo '}' >> $combined_json_file # project

    # Download job logs

    # for pipeline_id in ${pipeline_ids[@]}; do
    for i in ${!pipeline_ids[@]}; do
        # echo pipeline $i
        pipeline_id=${pipeline_ids[$i]}
        # if [[ ! $pipeline_id = 156496 ]]; then continue; fi
        echo "pipeline_ids ${pipeline_ids[@]}"
        echo "pipeline i: $i"
        echo "pipeline id: ${pipeline_ids[$i]} "
        echo "length: ${#pipeline_ids[@]}"
        # next_pipeline_id="${pipeline_ids[$((i+1))]}"
        if (( $((i+1)) < ${#pipeline_ids[@]})); then
            next_pipeline_id=${pipeline_ids[$((i+1))]}
            echo "next_pipeline_id $next_pipeline_id"
            failed_job_names_json=responses/projects/$project_id/pipelines/by_id/$next_pipeline_id/failed_job_names.json
        else
            echo "NO next_pipeline_id"
            failed_job_names_json=responses/dummy_failed_job_names.json
            echo "[]" > $failed_job_names_json
        fi
        # Download logs for jobs who either:
        # 1. failed for the current pipeline
        # 2. failed for the next day pipeline (based on matching job name). This is so we can do a dependency diff between the two jobs.
        # note: defining `IN` because jq is only v1.5 on EC2 (`IN` introduced in 1.6). https://stackoverflow.com/a/43269105/533591
        job_ids_to_download=$(\
            jq --argfile failed_job_names $failed_job_names_json \
            -s 'def IN(s): first((s == .) // empty) // false; [. | flatten | .[] | select(.status=="failed" or (.name|IN($failed_job_names[]))) | .id | tostring] | join(" ")' \
            responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json -r\
        )
        echo "job_ids_to_download: $job_ids_to_download"
        # Run CURLs in background (using `&`), and then `wait` for all requests to complete after the for loop
        for job_id in ${job_ids_to_download[@]}; do
            mkdir -p responses/projects/$project_id/jobs/$job_id
            echo "downloading job $job_id"
            curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/jobs/$job_id/trace" > responses/projects/$project_id/jobs/$job_id/trace &
        done
        wait

    done
done

echo ']' >> $combined_json_file # end of file

echo "Wrote to $combined_json_file"

# Selecting only fields which we'll use in the dashboard
cat $combined_json_file \
    | jq -c '[.[] | {metadata:{id:.metadata.id, name:.metadata.name, web_url:.metadata.web_url}, issues:.issues, nightly_user: .nightly_user, pipelines: (.pipelines|map({id:.id, status:.status, web_url:.web_url, created_at:.created_at})), pipeline_jobs:(.pipeline_jobs|to_entries|map({key:.key, value:{jobs:.value.jobs|map({id:.id, name:.name, status:.status, allow_failure:.allow_failure, web_url:.web_url, started_at:.started_at})}})|from_entries)}]' \
    > $combined_small_json_file
echo "Wrote to $combined_small_json_file"

rm $combined_json_file
echo "Deleted $combined_json_file to reduce GitLab artifact size"

date -u +"\"%Y-%m-%dT%H:%M:%SZ\"" > public/last_updated.json

