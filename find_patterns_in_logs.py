#!/usr/bin/env python3

import json
import glob
from pathlib import Path
import re
import sys

# Error patterns
# The first matched group (in brackets) is what is shown to the user
patterns = [
    r'(Unsatisfiable requirements detected for package [^\s]+)',
    r'Got exception outside of a @test (.+?)\s+Stacktrace:',
    r'Test Failed at.*?Expression: (.*?)\s+Stacktrace:',
    r'ERROR: (empty intersection between .* and project compatibility.*) Stacktrace:',
    r'ERROR:.*?(UndefVarError: .*? not defined)',
    r'ERROR:.*?Job failed: (execution took longer than .*?) seconds',
    r'(received signal: KILL)',
    r'ERROR: (failed to clone from .+?), error: GitError\(Code:ERROR, Class:OS, failed to connect to .*?: Operation timed out\) Stacktrace:',
    r'ERROR: Requested .+? from .+? has (different version in metadata: \'.*?\')',
    r'FATAL: (password authentication failed for user ".+?")',
    r'(Backrun Failed)',
    r'(signal \(15\))',
    r'deploy_stack:CREATE_FAILED.+?Error Code: (.+?);',
    r'An error occurred \(.+?\) when calling the .+? operation: ([ -~]+)', # Boto error # Note: `[ -~]` matches any ASCII character (this is to match until the next color code)
    # r'ERROR:(.+)'
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

results = {}

for path in Path('responses').rglob('trace'):

    match = re.match(r'responses/projects/(\d+)/jobs/(\d+)/trace', str(path))
    if match is None:
        print("Path is not as expected")
        sys.exit(1)
    project_id = int(match.group(1))
    job_id = int(match.group(2))

    print(f"Project name: {projects[project_id]['path_with_namespace']}, project_id: {project_id}, job_id: {job_id}")

    with open(path, 'r') as f:
        text = f.read()

        for pattern in patterns:
            for match in re.finditer(pattern, text):
                match_result = {
                    # "pattern": pattern,
                    # "matched_text": match.group(0),
                    "matched_group": match.group(1),
                    # "_log_url": f"https://gitlab.invenia.ca/{projects[project_id]['path_with_namespace']}/-/jobs/{job_id}"
                }

                if project_id not in results:
                    results[project_id] = {}
                if job_id not in results[project_id]:
                    results[project_id][job_id] = []
                results[project_id][job_id].append(match_result)

        num_errors_found = len(results[project_id][job_id]) if project_id in results and job_id in results[project_id] else 0
        print(f"Found {num_errors_found} error(s) in {path}")

output_file = 'public/patterns_in_logs.json'
with open(output_file, 'w') as f:
    json.dump(results, f)
    print(f"Wrote to {output_file}")

