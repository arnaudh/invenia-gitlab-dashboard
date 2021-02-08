#!/usr/bin/env python3

import json
import glob
from pathlib import Path
import re
import sys

# Error patterns
# The first capturing group (in brackets) is what is shown to the user
patterns = [
    r'(Unsatisfiable requirements detected for package [^\s]+)',
    r'Got exception outside of a @test (.+?)\s+Stacktrace:',
    r'Test Failed at.*?Expression: (.*?)\s+Stacktrace:',
    r'ERROR:.*?(UndefVarError: .*? not defined)',
    r'ERROR:.*?Job failed: (execution took longer than .*?) seconds',
    r'(received signal: KILL)',
    r'ERROR: (Requested .+? from .+? has different version in metadata: \'.*?\')',
    r'FATAL: (password authentication failed for user ".+?")',
    r'(Backrun Failed)',
    r'(signal \(15\))',
    r'(Segmentation fault)',
    r'deploy_stack:CREATE_FAILED.+?Error Code: (.+?);',
    r'An error occurred ([ -~]+)', # Boto error # Note: `[ -~]` matches any ASCII character (this is to match until the next color code)
    r'(UndesiredFinalState: .+? entered the undesired final state .+?) section_end', # cloudspy error
    r'Error response from daemon: (.+?) section_end', # aws ecr get-login
    r'(mv: cannot move .+? No such file or directory)',
]

# Try the above patterns first, if no matches try the ones below (may be more verbose)
backup_patterns = [
    r'([Cc]ommand .+? failed with (exit status|error code) \d+)',
    r'ERROR:(?: \[22m\[39m)?(?: LoadError:)? (.+?) Stacktrace:',
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


def find_pattern_occurences(pattern, text, pattern_type):
    results = []
    for match in re.finditer(pattern, text):
        match_result = {
            # "pattern": pattern,
            # "matched_text": match.group(0),
            "pattern_type": pattern_type,
            "matched_group": match.group(1),
            # "_log_url": f"https://gitlab.invenia.ca/{projects[project_id]['path_with_namespace']}/-/jobs/{job_id}"
        }
        results.append(match_result)
        # print("MATCH", match_result)
    return results



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

        job_results = []
        # First try normal patterns
        for pattern in patterns:
            job_results.extend(find_pattern_occurences(pattern, text, "normal"))
        # Then backup patterns
        for pattern in backup_patterns:
            job_results.extend(find_pattern_occurences(pattern, text, "backup"))

        if len(job_results) > 0:
            if project_id not in results:
                results[project_id] = {}
            results[project_id][job_id] = job_results

        num_errors_found = len(job_results)
        print(f"Found {num_errors_found} error(s) in {path}")

output_file = 'public/patterns_in_logs.json'
with open(output_file, 'w') as f:
    json.dump(results, f)
    print(f"Wrote to {output_file}")

