#!/usr/bin/env python3

import json
import glob
from pathlib import Path
import re
import sys

patterns = [
    r'(Unsatisfiable requirements detected for package [^\s]+)',
    # r'Some tests did not pass: \d+ passed, \d+ failed, \d+ errored, \d+ broken\.',
    r'Got exception outside of a @test (.+?)\s+Stacktrace:',
    r'Test Failed at.*?Expression: (.*?)\s+Stacktrace:',
    r'ERROR: (empty intersection between .* and project compatibility.*) Stacktrace:',
    r'ERROR:.*?(UndefVarError: .*? not defined)',
    r'ERROR:.*?Job failed: (execution took longer than .*?) seconds',
    r'(received signal: KILL)',
    # r'(errored during testing Stacktrace)',
    r'ERROR: (failed to clone from .+?), error: GitError\(Code:ERROR, Class:OS, failed to connect to .*?: Operation timed out\) Stacktrace:',
    r'ERROR: Requested .+? from .+? has (different version in metadata: \'.*?\')',
    r'FATAL: (password authentication failed for user ".+?")',
    r'(Backrun Failed)',
    r'(signal \(15\))',
    r'deploy_stack:CREATE_FAILED.+?Error Code: (.+?);'
    # r'ERROR:(.+)'
]

julia_exception_patterns = [
    r'MethodError: (no method matching .*?)Closest candidates are:'
]


# # TODO explore many kinds of error before deciding on this "smart" hierarchy approach (maybe it doesn't apply that well)
# error_hierarchy = [
#     {
#         'name': 'Julia',
#         'children': [
#             'name': 'Exception while running tests'
#             'pattern': r'Got exception outside of a @test (.+)\. Stacktrace:'
#             'children': [
#                 {
#                     'name': 'No method matching',
#                     'pattern': r'MethodError: (no method matching .*)Closest candidates are:'

#                 }
#             ]
#         ]
#     }
# ]



projects = {}
for f in glob.glob("responses/projects/*.json"):
    with open(f, "rb") as infile:
        for project in json.load(infile):
            projects[project["id"]] = project

# print(projects)
# sys.exit(1)

results = {}

for path in Path('responses').rglob('trace'):
    print(path)

    match = re.match(r'responses/projects/(\d+)/jobs/(\d+)/trace', str(path))
    if match is None:
        print("Path is not as expected")
        sys.exit(1)
    project_id = int(match.group(1))
    job_id = int(match.group(2))

    print(f"project name: {projects[project_id]['path_with_namespace']}, project_id: {project_id}, job_id: {job_id}")

    with open(path, 'r') as f:
        text = f.read()
        # print("text")
        # print(text)

        for pattern in patterns:
            for match in re.finditer(pattern, text):
                # print("match", match.group(1))
                # print(match)
                # print(match.group(0))

                match_result = {
                    "pattern": pattern,
                    "matched_text": match.group(0),
                    "matched_group": match.group(1),
                    "_log_url": f"https://gitlab.invenia.ca/{projects[project_id]['path_with_namespace']}/-/jobs/{job_id}"
                }

                if project_id not in results:
                    results[project_id] = {}
                if job_id not in results[project_id]:
                    results[project_id][job_id] = []
                results[project_id][job_id].append(match_result)
    
    # sys.exit(1)


# error_index = {
#     'All Forecasters failed. See previous warnings': [job_ids]
# }

output_file = 'public/patterns_in_logs.json'
with open(output_file, 'w') as f:
    json.dump(results, f)
    print(f"Wrote to {output_file}")

