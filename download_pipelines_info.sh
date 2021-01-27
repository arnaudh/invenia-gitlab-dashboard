#!/bin/bash

# set -x
set -eu -o pipefail

# To run:
#  1. Generate Gitlab Personal Access Token https://gitlab.invenia.ca/profile/personal_access_tokens (checking read_user, read_api, read_repository)
#  2. Run:
#   export AWS_PROFILE=ci
#   ./download_pipelines_info.sh

echo "Getting Gitlab API access token from AWS SSM"
GITLAB_ACCESS_TOKEN=$(aws ssm get-parameter --name gitlab-dashboard-access-token --with-decryption --query Parameter.Value --output text)

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
    echo $output
}


download_projects() {
    curl_wrapper --dump-header responses/projects/head -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects?per_page=100" > /dev/null

    # n_projects=$(cat responses/projects/head | grep X-Total: | sed 's/[^0-9]*//g')
    n_pages=$(cat responses/projects/head | grep X-Total-Pages: | sed 's/[^0-9]*//g')

    for (( page = 1; page <= $n_pages; page++ )); do
        echo $page
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects?per_page=100&page=$page" > responses/projects/page_$page.json
    done
    # jq -s '.|flatten|length' responses/projects/*.json
}

download_projects

project_ids=($(jq -s '. | flatten | map(.id) | join(" ")' responses/projects/*.json -r))
# project_ids=(241 460 353 201 473 508 533 536) # (BidFiles.jl GLMForecasters.jl GPForecasters.jl S3DB.jl Backruns.jl Features.jl GLMModels.jl<rse> WrapperModels.jl<rse>)
# project_ids=(473 508 533 536) # (Backruns.jl Features.jl GLMModels.jl<rse> WrapperModels.jl<rse>)

nightly_users=(nightly-dev nightly-rse)

MAX_N_PIPELINES=30

combined_json_file=public/combined.json
echo '[' > $combined_json_file

# progress bar function
prog() {
    local w=80 p=$1 total=$2;  shift
    # create a string of spaces, then change them to dots
    printf -v dots "%*s" "$(( $p*$w/$total ))" ""; dots=${dots// /.};
    # print those dots on a fixed-width space plus the percentage etc. 
    printf "\r\e[K|%-*s| %3d / %s" "$w" "$dots" "$p" "$*"; 
}

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

    for nightly_user in ${nightly_users[@]}; do
        mkdir -p responses/projects/$project_id/pipelines/by_user/$nightly_user
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines?username=${nightly_user}&per_page=$MAX_N_PIPELINES" > responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json
        num_pipelines=$(jq 'length' responses/projects/$project_id/pipelines/by_user/$nightly_user/page_1.json)
        # echo $num_pipelines
        if [[ $num_pipelines -gt 0 ]]; then
            echo ',"nightly_user":"'$nightly_user'"' >> $combined_json_file
        fi
    done
    echo ',"pipelines":' >> $combined_json_file
    jq -s '.|flatten' responses/projects/$project_id/pipelines/by_user/*/*.json -r >> $combined_json_file

    # pipeline status is one of: created, waiting_for_resource, preparing, pending, running, success, failed, canceled, skipped, manual, scheduled 
    failed_pipeline_ids=$(jq -s '[. | flatten | .[] | select(.status=="failed") | .id] | join(" ")' responses/projects/$project_id/pipelines/by_user/*/*.json -r)
    echo ',"failed_pipelines":{' >> $combined_json_file

    first_iteration_inner_loop=true
    for pipeline_id in ${failed_pipeline_ids[@]}; do
        # Hack to add commas between json array elements
        if [[ $first_iteration_inner_loop = true ]]; then first_iteration_inner_loop=false; else echo "," >> $combined_json_file; fi

        mkdir -p responses/projects/$project_id/pipelines/by_id/$pipeline_id/
        curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines/$pipeline_id/jobs" > responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json
        
        echo "\"$pipeline_id\":{" >> $combined_json_file
        echo '"jobs":' >> $combined_json_file
        cat responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json >> $combined_json_file

        failed_job_ids=$(jq -s '[. | flatten | .[] | select(.status=="failed") | .id] | join(" ")' responses/projects/$project_id/pipelines/by_id/$pipeline_id/jobs.json -r)
        for job_id in ${failed_job_ids[@]}; do
            mkdir -p responses/projects/$project_id/jobs/$job_id
            curl_wrapper -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/jobs/$job_id/trace" > responses/projects/$project_id/jobs/$job_id/trace
        done

        echo '}' >> $combined_json_file # pipeline_id
    done
    echo '}' >> $combined_json_file # failed_pipelines
    echo '}' >> $combined_json_file # project
done

echo ']' >> $combined_json_file # end of file

echo "Wrote to $combined_json_file"

