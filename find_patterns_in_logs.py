#!/usr/bin/env python3

from datetime import datetime
import json
import glob
from pathlib import Path
import re
import sys

# Error patterns
# The first capturing group (in brackets) is what is shown to the user
patterns = [
    r'(Unsatisfiable requirements detected for package [^\s]+)',
    r'Got exception outside of a @test\s+(?:.*?nested task error: )?(.+?)\s+Stacktrace:',
    r'Test (?:Failed at|threw exception).*?Expression: (.*?)\s+Stacktrace:',
    r'(UndefVarError: .*? not defined)',
    r'Job failed: (execution took longer than .*?) seconds',
    r'(received signal: KILL)',
    r'(Killed: 9)',
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
    r'JULIA: (.*?Error: .+?)\s+Stacktrace', # PyJulia
    r'\n((E\s+[^\n]+\n)+)', # Python error (Capturing the "E" prefix because it is there on every line for multiline errors)
]

# Try the above patterns first, if no matches try the ones below (may be less informative or more verbose)
backup_patterns = [
    r'([Cc]ommand (".+?"|\'.+?\') failed with (exit status|error code) \d+)',
    # Generic julia error. Limitting the number of characters matched so as not to make the
    # regex runtime blow up (can take seconds to run otherwise)
    r'ERROR:(?: LoadError:)? (.{1,10000}?)\s+Stacktrace:',
]

ignore_patterns = [
    r'Package .+ errored during testing',
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

def load_projects_metadata():
    projects = {}
    for f in glob.glob("responses/projects/*.json"):
        with open(f, "rb") as infile:
            for project in json.load(infile):
                projects[project["id"]] = project
    return projects


def find_pattern_occurences(pattern, text, pattern_type):
    results = []
    for match in re.finditer(pattern, text, flags=re.DOTALL):
        match_result = {
            # "pattern": pattern,
            # "matched_text": match.group(0),
            "pattern_type": pattern_type,
            "matched_group": match.group(1),
            # "_log_url": f"https://gitlab.invenia.ca/{projects[project_id]['path_with_namespace']}/-/jobs/{job_id}"
        }
        results.append(match_result)
        # print(datetime.now(), "MATCH", match_result)
    return results

# Dependences are printed in the logs when running tests for a given package, e.g.:
# ```
#   ...
#      Testing AgentSPP
#       Status `/tmp/jl_YQC30Y/Project.toml`
#   [abb87260] AgentSPP v1.5.0 `/builds/invenia/AgentSPP.jl`
#   [6ac7752a] Agents v0.19.20
#   ...
#   [ade2ca70] Dates `@stdlib/Dates`
#   [8dfed614] Test `@stdlib/Test`
#       Status `/tmp/jl_YQC30Y/Manifest.toml`
#   [fbe9abb3] AWS v1.68.0
#   [1c724243] AWSS3 v0.9.2
#   ...
#   [8e850ede] nghttp2_jll `@stdlib/nghttp2_jll`
#   [3f19e933] p7zip_jll `@stdlib/p7zip_jll`
# Precompiling project...
# ```
# The dependencies we care about are the ones showing in the Manifest.toml section.
# The dependencies list ends when there is no more entry starting with an open bracket '['.
# We can't rely on "Precompiling project..." always being at the end (see
# https://gitlab.invenia.ca/invenia/gitlab-dashboard/-/issues/17).
# Note sometimes dependencies show up with a +:
#   [1c724243] + AWSS3 v0.9.2
test_section_regex = r"Status .*\/Manifest\.toml`\n(?P<dep_list>(\s*\[.+\n)+)"
dependency_regex = r"\[(?P<uuid_short>.*?)\](?: \+)? (?P<name>.*?) (?P<version>.*?)\n"

# https://stackoverflow.com/questions/14693701/how-can-i-remove-the-ansi-escape-sequences-from-a-string-in-python
def remove_ansi_escapes(text):
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

def get_manifest_test_dependencies(clean_text):
    match = re.search(test_section_regex, clean_text)
    if match is None:
        print(datetime.now(), "text did not match test_section_regex")
        return []

    matches = re.findall(dependency_regex, match.group("dep_list"))
    if len(matches) == 0:
        print(datetime.now(), "no deps found matching dependency_regex")
        sys.exit(1)

    dependencies = []
    for match in matches:
        dependencies.append({
            'uuid': match[0],
            'name': match[1],
            'version': match[2],
        })
    return sorted(dependencies, key=lambda x: x['name'])

def extract_info_from_log_files(paths, projects):
    extracted_info = {}
    for i, path in enumerate(paths):
        match = re.match(r'responses/projects/(\d+)/jobs/(\d+)/trace', str(path))
        if match is None:
            print(datetime.now(), "Path is not as expected")
            sys.exit(1)
        project_id = int(match.group(1))
        job_id = int(match.group(2))

        print(datetime.now(), f"[{i+1}/{len(paths)}] Project name: {projects[project_id]['path_with_namespace']}, project_id: {project_id}, job_id: {job_id}")

        dependencies, error_messages = extract_info_from_log_file(path)

        if len(dependencies) > 0 or len(error_messages) > 0:
            if project_id not in extracted_info:
                extracted_info[project_id] = {}
            extracted_info[project_id][job_id] = {}
            extracted_info[project_id][job_id]["dependencies"] = dependencies
            extracted_info[project_id][job_id]["error_messages"] = error_messages

    return extracted_info

def extract_info_from_log_file(path):
    with open(path, 'r') as f:
        text = remove_ansi_escapes(f.read())

        print(datetime.now(), "path", path)
        dependencies = get_manifest_test_dependencies(text)
        print(datetime.now(), f"Found {len(dependencies)} dependencies in {path}")

        error_messages = []
        for pattern in patterns:
            error_messages.extend(find_pattern_occurences(pattern, text, "normal"))
        for pattern in backup_patterns:
            error_messages.extend(find_pattern_occurences(pattern, text, "backup"))
        # Discard unuseful patterns
        error_messages = [e for e in error_messages if not any([re.search(p, e["matched_group"]) for p in ignore_patterns])]
        print(datetime.now(), f"Found {len(error_messages)} error(s) in {path}")

        return dependencies, error_messages

def save_to_file(obj, output_file):
    with open(output_file, 'w') as f:
        json.dump(obj, f)
        print(datetime.now(), f"Wrote to {output_file}")

if __name__ == "__main__":
    projects = load_projects_metadata()
    paths = list(Path('responses').rglob('trace'))
    extracted_info = extract_info_from_log_files(paths, projects)
    save_to_file(extracted_info, 'public/extracted_info.json')

