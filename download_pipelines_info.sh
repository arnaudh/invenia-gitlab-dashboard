#!/bin/bash

set -eux -o pipefail

# To run:
#  1. Generate Gitlab Personal Access Token https://gitlab.invenia.ca/profile/personal_access_tokens (checking read_user, read_api, read_repository)
#  2. Run:
#   export GITLAB_ACCESS_TOKEN=XXXXXX
#   ./download_pipelines_info.sh

mkdir -p responses/projects/

download_projects() {
    curl --head -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects?per_page=100" > responses/projects/head

    # n_projects=$(cat responses/projects/head | grep X-Total: | sed 's/[^0-9]*//g')
    n_pages=$(cat responses/projects/head | grep X-Total-Pages: | sed 's/[^0-9]*//g')

    for (( page = 1; page <= $n_pages; page++ )); do
        echo $page
        curl -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects?per_page=100&page=$page" > responses/projects/page_$page.json
    done
    # jq -s '.|flatten|length' responses/projects/*.json
}

download_projects()


project_ids=$(jq -s '. | flatten | map(.id) | join(" ")' responses/projects/*.json -r)
# project_ids=(241 460 353 201 473 508) # (BidFiles.jl GLMForecasters.jl GPForecasters.jl S3DB.jl Backruns.jl Features.jl)

nightly_user=nightly-dev

MAX_N_PIPELINES=30

combined_json_file=web/combined.json
echo '[' > $combined_json_file


first_iteration=true
for project_id in ${project_ids[@]}; do
    # Hack to add commas between json array elements
    if [[ $first_iteration = true ]]; then first_iteration=false; else echo "," >> $combined_json_file; fi

    echo '{' >> $combined_json_file

    mkdir -p responses/projects/$project_id/pipelines/
    curl -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id" > responses/projects/$project_id/project.json
    echo '"metadata":' >> $combined_json_file
    cat responses/projects/$project_id/project.json >> $combined_json_file

    curl -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines?username=${nightly_user}&per_page=$MAX_N_PIPELINES" > responses/projects/$project_id/pipelines/page_1.json
    echo ',"pipelines":' >> $combined_json_file
    jq -s '.|flatten' responses/projects/$project_id/pipelines/*.json -r >> $combined_json_file

    # pipeline status is one of: created, waiting_for_resource, preparing, pending, running, success, failed, canceled, skipped, manual, scheduled 
    failed_pipeline_ids=$(jq -s '[. | flatten | .[] | select(.status="failed") | .id] | join(" ")' responses/projects/$project_id/pipelines/*.json -r)
    echo ',"failed_pipelines":{' >> $combined_json_file

    first_iteration_inner_loop=true
    for pipeline_id in ${failed_pipeline_ids[@]}; do
        # Hack to add commas between json array elements
        if [[ $first_iteration_inner_loop = true ]]; then first_iteration_inner_loop=false; else echo "," >> $combined_json_file; fi

        mkdir -p responses/projects/$project_id/pipelines/$pipeline_id/
        curl -H "Private-Token: $GITLAB_ACCESS_TOKEN" "https://gitlab.invenia.ca/api/v4/projects/$project_id/pipelines/$pipeline_id/jobs" > responses/projects/$project_id/pipelines/$pipeline_id/jobs.json
        
        echo "\"$pipeline_id\":{" >> $combined_json_file
        echo '"jobs":' >> $combined_json_file
        cat responses/projects/$project_id/pipelines/$pipeline_id/jobs.json >> $combined_json_file
        echo '}' >> $combined_json_file # pipeline_id
    done
    echo '}' >> $combined_json_file # failed_pipelines
    echo '}' >> $combined_json_file # project
done
echo ']' >> $combined_json_file # end of file

echo "Wrote to $combined_json_file"

