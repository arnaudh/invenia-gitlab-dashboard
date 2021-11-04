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

# Try the above patterns first, if no matches try the ones below (may be less informative or more verbose)
backup_patterns = [
    r'([Cc]ommand (".+?"|\'.+?\') failed with (exit status|error code) \d+)',
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

# test_section_regex = r"\x1B\[1m Testing\x1B\[22m\x1B\[39m (?P<package_name>.*?) \x1B.*\/Manifest.toml` (?P<dep_list>.*)\x1B\[32m\x1B\[1mPrecompiling\x1B\[22m\x1B\[39m project"
test_section_regex = r" Testing (?P<package_name>.*?) .*?\/Manifest.toml` (?P<dep_list>.*?)Precompiling project"
# test_section_regex = r" Testing\s+(.*?Predictors)"
dependency_regex = r"\[(?P<uuid_short>.*?)\](?: \+)? (?P<name>.*?) (?P<version>.*?) "

# https://stackoverflow.com/questions/14693701/how-can-i-remove-the-ansi-escape-sequences-from-a-string-in-python
def remove_ansi_escapes(text):
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    # ansi_escape = re.compile(r'[^ -~]')
    return ansi_escape.sub('', text)

def get_manifest_test_dependencies(text):
    # Start
    #   [32m[1m Testing[22m[39m Features 
    #   ...
    #   [32m[1m Status[22m[39m `~/builds/f75a2375/0/invenia/Features.jl.tmp/jl_s1ztoa/Manifest.toml` 
    # deps show up as:
    #   [90m [fbe9abb3] [39mAWS v1.69.0
    # OR (with a `+`):
    #   [1c724243] + AWSS3 v0.9.2
    # current package:
    #   [90m [a481f681] [39mFeatures v3.1.1 `~/builds/f75a2375/0/invenia/Features.jl` 
    # Stdlib deps show up as:
    #   [cf7118a7] [39mUUIDs `@stdlib/UUIDs`
    # Some deps get built in the middle:
    #   [32m[1m Building[22m[39m TimeZones →
    # At the end of the list we have:
    #   [32m[1mPrecompiling[22m[39m project... 
    clean_text = remove_ansi_escapes(text)
    match = re.search(test_section_regex, clean_text)
    # match = re.search(r"\x1B(.*?)Manifest", text))
    if match is None:
        # print(text)
        print("text did not match test_section_regex")
        # sys.exit(1)
        return []
    # print(f"match.group()=[{match.group()}]")

    matches = re.findall(dependency_regex, match.group("dep_list"))
    if len(matches) == 0:
        print("no deps found matching dependency_regex")
        sys.exit(1)

    dependencies = []
    for match in matches:
        # print("match", match)
        dependencies.append({
            'uuid': match[0],
            'name': match[1],
            'version': match[2],
        })
    return sorted(dependencies, key=lambda x: x['name'])


extracted_info = {}

for path in Path('responses').rglob('trace'):
    match = re.match(r'responses/projects/(\d+)/jobs/(\d+)/trace', str(path))
    if match is None:
        print("Path is not as expected")
        sys.exit(1)
    project_id = int(match.group(1))
    job_id = int(match.group(2))
    # if job_id != 1305773:
    #     continue

    print(f"Project name: {projects[project_id]['path_with_namespace']}, project_id: {project_id}, job_id: {job_id}")

    with open(path, 'r') as f:
        text = f.read()

        print("path", path)
        dependencies = get_manifest_test_dependencies(text)
        print(f"Found {len(dependencies)} dependencies in {path}")

        error_messages = []
        for pattern in patterns:
            error_messages.extend(find_pattern_occurences(pattern, text, "normal"))
        for pattern in backup_patterns:
            error_messages.extend(find_pattern_occurences(pattern, text, "backup"))
        print(f"Found {len(error_messages)} error(s) in {path}")

        if len(dependencies) > 0 or len(error_messages) > 0:
            if project_id not in extracted_info:
                extracted_info[project_id] = {}
            extracted_info[project_id][job_id] = {}
            extracted_info[project_id][job_id]["dependencies"] = dependencies
            extracted_info[project_id][job_id]["error_messages"] = error_messages


def save_to_file(obj, output_file):
    with open(output_file, 'w') as f:
        json.dump(obj, f)
        print(f"Wrote to {output_file}")

save_to_file(extracted_info, 'public/extracted_info.json')

