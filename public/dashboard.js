
const DEFAULTS = {
    "repos": "all",
    "search": "", // search filter
    "display_job_names": true,
    "display_errors": true,
    "display_dependencies": false,
    "display_runner": false,
    "display_jobs_failed": true,
    "display_jobs_failed_allow_failure": false,
    "display_jobs_passed": false,
    "display_jobs_other": false,
}

// Would need to modify the download script to go further back
DAYS_AGO=29;

const JOB_STRING_DISPLAY_LIMIT = 1000;
const ERROR_STRING_DISPLAY_LIMIT = 10;

let projects;
let projects_dict;
let extracted_info;
let last_updated;
let eis_dependencies;

//=================================
//      Utility functions
//=================================

function remove_defaults_and_null_values(obj) {
    const clone = {...obj}; // note: shallow clone (ok in this case)
    for (let propName in clone) {
        if (clone[propName] === DEFAULTS[propName] || clone[propName] === null) {
        // if (clone[propName] === null) {
            delete clone[propName];
        }
    }
    return clone;
}

function treatAsUTC(date) {
    var result = new Date(date);
    result.setMinutes(result.getMinutes() - result.getTimezoneOffset());
    return result;
}

function daysBetween(startDate, endDate) {
    var millisecondsPerDay = 24 * 60 * 60 * 1000;
    return Math.floor((treatAsUTC(endDate) - treatAsUTC(startDate)) / millisecondsPerDay);
}

function isSameDay(startDate, endDate) {
    return daysBetween(startDate, endDate) === 0;
}

function add_days(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

// Display dates from Winnipeg perspective, because the Dev team is primarily based in Winnipeg,
// and also because "last night" more intuitively means "yesterday evening" vs "early this morning".
// Nightly pipelines run at 8pm Winnipeg time, which is 1 or 2am UTC the next day.
// Hence we display them as being the previous day relative to the UTC date.
function display_date(UTC_date) {
    return add_days(UTC_date, -1);
}

function date_without_time(date) {
    let res = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    return res;
}

function dates_since(start_datetime) {
    let start_date = date_without_time(start_datetime);
    let now = Date.now();
    
    if (start_date > now) throw new Error(`Date not in the past: ${start_datetime}`);
    
    let dates = [];
    dates.push(start_date);

    let new_date = add_days(start_date, 1);
    while (new_date < now) {
        dates.push(new_date);
        new_date = add_days(new_date, 1);
    }

    return dates;
}

function has_pipelines_after_date(project, date) {
    return project.pipelines.some(p => date_without_time(new Date(p.created_at)).getTime() > date.getTime());
}

function get_pipelines_for_date(project, date) {
    return project.pipelines.filter(p => date_without_time(new Date(p.created_at)).getTime() === date.getTime());
}

function get_oldest_pipeline_date(projects) {
    let dates = projects.flatMap(function(p) {
        return p.pipelines.slice(-1).flatMap(function(pip) {
            return pip.created_at ? [new Date(pip.created_at)] : [];
        })
    });
    let min_date = new Date(Math.min.apply(null, dates));
    return min_date;
}

function get_newest_pipeline_date(projects) {
    let dates = projects.flatMap(function(p) {
        return p.pipelines.slice(0, 1).flatMap(function(pip) {
            return pip.created_at ? [new Date(pip.created_at)] : [];
        })
    });
    let min_date = new Date(Math.max.apply(null, dates));
    return min_date;
}

// Sort projects by having unsuccessful pipelines at the top (priority for more recent days)
function sort_projects_by_pipeline_status(projects, timeline_start) {
    return projects.sort(function (a, b) {
        for (date of dates_since(timeline_start).reverse()){
            let a_has_unsuccessful_pipelines = get_pipelines_for_date(a, date).some(p => p.status != "success");
            let b_has_unsuccessful_pipelines = get_pipelines_for_date(b, date).some(p => p.status != "success");
            if (a_has_unsuccessful_pipelines !== b_has_unsuccessful_pipelines) {
                // We have a winner
                if (a_has_unsuccessful_pipelines) {
                    return -1;
                } else {
                    return 1;
                }
            }
        }
        return 0;
    });
}

function show_error(str) {
    let error_div = document.getElementById('error-message');
    error_div.innerHTML = str;
    error_div.style.display = 'block';
}

function time_since(date) {
    // https://stackoverflow.com/a/3177838/533591
    var seconds = Math.floor((new Date() - date) / 1000);
    var interval = seconds / 31536000;
    if (interval > 1) {
        return Math.floor(interval) + " yr";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
        return Math.floor(interval) + " mth";
    }
    interval = seconds / 86400;
    if (interval > 1) {
        return Math.floor(interval) + " d";
    }
    interval = seconds / 3600;
    if (interval > 1) {
        return Math.floor(interval) + " h";
    }
    interval = seconds / 60;
    if (interval > 1) {
        return Math.floor(interval) + " min";
    }
    return Math.floor(seconds) + " s";
}

function is_in_prod(project) {
    return eis_dependencies.includes(project.metadata.name.replace(/\.jl$/, ""))
}

//=================================
//      Rendering functions
//=================================

function to_html_node(text_or_node) {
    if (typeof text_or_node === "string") {
        return document.createTextNode(text_or_node);
    } else {
        return text_or_node;
    }
}

function addTH(row, text_or_node, class_list=[]) {
    let th = document.createElement("th");
    th.innerHTML = text_or_node;
    if (class_list) {
        th.classList.add(...class_list);
    }
    row.appendChild(th);
}

function addCell(row, text_or_node, class_list=[]) {
    let cell = row.insertCell();
    cell.innerHTML = text_or_node;
    if (class_list) {
        cell.classList.add(...class_list);
    }
}

function pipeline_job_by_name(pipeline, job_name, project) {
    let jobs = pipeline && project.pipeline_jobs[pipeline.id].jobs.filter(j => j.name == job_name) || [];
    if (jobs.length > 1) {
        console.error("Multiple jobs in the pipeline with same name?? jobs=", project.pipeline_jobs[pipeline.id].jobs);
        return null;
    } else {
        return jobs[0];
    }
}

function render_pipeline(pipeline, previous_pipeline, project) {
    let state = window.history.state;
    let cellValue;
    let jobs = project.pipeline_jobs[pipeline.id].jobs;
    let jobs_to_show = jobs.filter(function(job) {
        return job.status == "failed" && !job.allow_failure && state.display_jobs_failed ||
            job.status == "failed" && job.allow_failure && state.display_jobs_failed_allow_failure ||
            job.status == "success" && state.display_jobs_passed ||
            !["success", "failed"].includes(job.status) && state.display_jobs_other;
    });
    if (jobs_to_show.length > 0 && (state.display_job_names || state.display_errors || state.display_dependencies || state.display_runner)) {
        cellValue = `<table class="pipeline-jobs">`;
        cellValue += jobs_to_show.map(function(job) {
            let previous_pipeline_job = pipeline_job_by_name(previous_pipeline, job.name, project);
            return render_job(job, previous_pipeline_job, project)
        }).join("");
        cellValue += `</table>`;
    } else if (pipeline.status === "success") {
        cellValue = `<a href="${pipeline.web_url}"><span title="success">✓</span></a>`;
    } else {
        cellValue = `<a href="${pipeline.web_url}"><span title="${pipeline.status}">${pipeline.status}</span></a>`;
    }
    return cellValue;
}

function remove_python_error_prefix(s) {
    return s.replace(/E\s+/g, '')
}

function limit_string(s, length) {
    return s.length > length ? s.substring(0, length - 3) + "…" : s;
}

function string_matches_filter(error_string, filter_string) {
    // if (filter_string === "*") {
    //     return true
    // } else if (filter_string.includes("*")) {
    //     // TODO Support glob (e.g. with https://github.com/isaacs/minimatch)
    //     console.log('Glob matching not supported yet');
    //     return false;
    // } else {
        return error_string.toLowerCase().includes(filter_string.toLowerCase());
    // }
}

function remove_duplicates(arr, key_fields) {
    return arr.filter(
        (s => o => 
            (k => !s.has(k) && s.add(k))
            (key_fields.map(k => o[k]).join('|'))
        )
        (new Set)
    );
}

function job_status_icon(job) {
    if (job.status == "failed") {
        if (job.allow_failure) {
            return `<span class="gitlab-status"><img src="images/gitlab-warning.png" title="failed (allowed to fail)"/></span>`;
        } else {
            return `<span class="gitlab-status"><img src="images/gitlab-failed.png" title="failed"/></span>`;
        }
    } else if (job.status == "success") {
        return `<span class="gitlab-status"><img src="images/gitlab-success.png" title="passed"/></span>`;
    } else {
        return `<span class="gitlab-status"><img src="images/gitlab-other.png" title="${job.status}"/></span>`;
    }
}

function dependencies_diff(old_packages, new_packages) {
    if (old_packages.length === 0 || new_packages.length === 0) {
        return null;
    }
    old_dict = Object.assign({}, ...old_packages.map(x => ({[x.name]: x})));
    new_dict = Object.assign({}, ...new_packages.map(x => ({[x.name]: x})));
    diffs = [];
    for (package of old_packages){
        if (package.name in new_dict) {
            if (package.version !== new_dict[package.name].version) {
                diffs.push({
                    "name":package.name,
                    "type":"edit",
                    "old_version":package.version,
                    "new_version":new_dict[package.name].version,
                });
            }
        } else {
            diffs.push({
                "name":package.name,
                "type":"delete",
                "old_version":package.version,
            });
        }
    }
    for (package of new_packages){
        if (!(package.name in old_dict)) {
            diffs.push({
                "name":package.name,
                "type":"add",
                "new_version":package.version,
            });
        }
    }
    diffs_sorted = diffs.sort((a, b) => a.name < b.name);
    return diffs_sorted;
}

// Test for dependencies_diff
//                 same version               new version               removed + added dep
    let old_list = [{"name":"A","version":1}, {"name":"B","version":1}, {"name":"C","version":1}];
    let new_list = [{"name":"A","version":1}, {"name":"B","version":2}, {"name":"D","version":1}];
    let expected_result = [
        {"name":"B","type":"edit","old_version":1,"new_version":2},
        {"name":"C","type":"delete","old_version":1},
        {"name":"D","type":"add","new_version":1},
    ];
    actual_result = dependencies_diff(old_list, new_list);
    // console.log("actual_result", actual_result);
    // console.log("expected_result", expected_result);
    console.assert(JSON.stringify(actual_result) == JSON.stringify(expected_result), "test for dependencies_diff failed");
// end test


function render_dependencies_diff_short(dep_diff) {
    let num = dep_diff === null ? "?" : dep_diff.length;
    return `∴${num}`;
}

function render_dependencies_diff_pretty(dep_diff) {
    let message = "";
    if (dep_diff === null) {
        message = "?";
    } else {
        diff_strings = dep_diff.map(function (obj) {
            let s;
            uppercase_letters = obj.name.match(/([A-Z])/g) || [obj.name[0]];
            let short_name = uppercase_letters.join("");
            if (obj.type === "edit") {
                s = `<td class="dependency-name">${short_name}</td><td class="dependency-version">${obj.new_version}</td>`;
            } else if (obj.type === "delete") {
                s = `<td class="dependency-name">-${short_name}</td><td class="dependency-version"></td>`;
            } else if (obj.type === "add") {
                s = `<td class="dependency-name">+${short_name}</td><td class="dependency-version">${obj.new_version}</td>`;
            } else {
                throw `unknown diff type ${obj.type}`;
            };
            return `<tr>${s}</tr>`;
        });
        message = `<table>` + diff_strings.join("") + `</table>`;
    }
    return message;
}

function render_dependency_change(package_name, old_version, new_version, markdown=false) {
    let name_prefix = "";
    if (old_version && !new_version) {
        name_prefix = "-";
    } else if (!old_version && new_version) {
        name_prefix = "+";
    }
    let old_version_html = old_version || "";
    let new_version_html = "";
    function render_link(text, url) {
        if (markdown) {
            return `[${text}](${url})`;
        } else {
            return `<a href="${url}" target="_blank">${text}</a>`;
        }
    }
    if (new_version) {
        if (projects_dict[package_name+".jl"]) {
            let release_url = `${projects_dict[package_name+".jl"].metadata.web_url}/-/releases/${new_version}`;
            new_version_html = render_link(new_version, release_url)
            if (old_version) {
                let compare_url = `${projects_dict[package_name+".jl"].metadata.web_url}/-/compare/${old_version}...${new_version}`;
                if (markdown) {
                    new_version_html = `-> ${new_version_html} (${render_link("compare", compare_url)})`;
                } else {
                    new_version_html = render_link("->", compare_url) + " " + new_version_html;
                }
            }
        } else {
            new_version_html = old_version ? `-> ${new_version}` : new_version;
        }
    }

    if (markdown) {
        return `* ${name_prefix}${package_name} ${old_version_html} ${new_version_html}`;
    } else {
        return `<td class="dependency-name">${name_prefix}${package_name}</td><td class="dependency-version">${old_version_html}</td><td class="dependency-version">${new_version_html}</td>`;
    }
}

function render_dependencies_diff_full(dep_diff) {
    let message = "";
    if (dep_diff === null) {
        // message = "?";
        message = "<i>Couldn't get a dependency list for this job and/or the job from the previous day.</i>";
    } else {
        if (dep_diff.length === 0) {
            message = `<i>None.</i>`;
        } else {
            message = `<div class="dependencies-full">`;
            diff_strings = dep_diff.map(function (obj) {
                return `<tr>${render_dependency_change(obj.name, obj.old_version, obj.new_version)}</tr>`;
            });
            message += `<table>` + diff_strings.join("") + `</table>`;
            message += `</div>`;
        }
    }
    return message;
}

function render_dependencies_markdown(dep_diff, previous_job) {
    let previous_job_info = `[previous day](${previous_job.web_url}) (${previous_job.status})`;
    let message = ``;
    if (dep_diff) {
        if (dep_diff.length === 0) {
            message += `No dependency changes from the ${previous_job_info}.\n\n`;
        } else {
            message += `Dependency changes from the ${previous_job_info}:\n\n`;
            diff_strings = dep_diff.map(function (obj) {
                return render_dependency_change(obj.name, obj.old_version, obj.new_version, markdown=true);
            });
            message += diff_strings.join("\n") + `\n\n`;
        }
    }
    return message;
}

function new_issue_url(project, job, previous_job, patterns_to_actually_show, dep_diff) {
    let title = ``; // Better force user to choose an appropriate title
    let job_start_date = job.started_at ? " on " + display_date(new Date(job.started_at)).toISOString().slice(0, 10) : "";
    let description = `/label ~nightly\n\n`;
    description += `Nightly job  [\`${job.name}\`](${job.web_url}) ${job.status}${job_start_date}.\n\n`;
    if (patterns_to_actually_show.length > 0) {
        description += patterns_to_actually_show.map(p => "```\n" + p.matched_group + "\n```").join("\n");
        description += `\n\n`;
    }
    if (previous_job) {
        description += render_dependencies_markdown(dep_diff, previous_job);
    }
    return `${project.metadata.web_url}/-/issues/new?issue[title]=${encodeURIComponent(title)}&issue[description]=${encodeURIComponent(description)}`;
}

function escapeHtml(html){
    let text = document.createTextNode(html);
    let p = document.createElement('p');
    p.appendChild(text);
    return p.innerHTML;
}

function render_job(job, previous_job, project) {
    let state = window.history.state;
    let search_filter = state.search;
    let all_patterns = extracted_info[project.metadata.id] && extracted_info[project.metadata.id][job.id] && extracted_info[project.metadata.id][job.id]["error_messages"] || [];
    let patterns_deduplicated = remove_duplicates(all_patterns, ["matched_group"]); // remove additional patterns that have the same matched_group
    let dependencies = extracted_info[project.metadata.id] && extracted_info[project.metadata.id][job.id] && extracted_info[project.metadata.id][job.id]["dependencies"] || [];
    let dependencies_previous_job = previous_job && extracted_info[project.metadata.id] && extracted_info[project.metadata.id][previous_job.id] && extracted_info[project.metadata.id][previous_job.id]["dependencies"] || [];

    // Only show "backup" errors if there are no normal ones (backup errors are kind of
    // catch-all; less informative or more verbose). This is to show only the likely most
    // useful messages for each failed job. However this is not ideal, since a job can fail
    // with non-backup errors another day, in which case the backup errors will not be
    // displayed, which makes it look like some errors (the backup ones) that were there
    // before are now gone.
    let patterns_normal = patterns_deduplicated.filter(p => p.pattern_type == "normal");
    let patterns_backup = patterns_deduplicated.filter(p => p.pattern_type == "backup");
    let patterns_pre_filter = (patterns_normal.length > 0) ? patterns_normal : patterns_backup;

    let show_job;
    let patterns_filtered;
    if (search_filter === "") {
        show_job = true;
        patterns_filtered = patterns_pre_filter;
    } else {
        let errors_matching_filter = patterns_pre_filter.filter(p => string_matches_filter(p.matched_group, search_filter));
        if (errors_matching_filter.length > 0) {
            show_job = true;
            patterns_filtered = errors_matching_filter;
        } else {
            show_job = string_matches_filter(job.name, search_filter);
            patterns_filtered = patterns_pre_filter;
        }
    }

    let html;
    if (show_job) {
        html = `<tr>`;
        if (state.display_job_names) {
            html += `<td class="job-name">`;
            html += `<span>`;
            html += `<span class="tooltip">`;
            html += `<a href="${job.web_url}" target="_blank" rel="noopener noreferrer">${shorten_job_name(job.name)}</a>`;
            
            let dep_diff = dependencies_diff(dependencies_previous_job, dependencies);
            // Tooltip
            html += `<span><span class="tooltiptext">`;
            html += job.name;
            html += `<a href="${new_issue_url(project, job, previous_job, patterns_pre_filter, dep_diff)}" target="_blank" class="new-issue">New issue</a>`;
            html += `<h3>Runner:</h3>`;
            if (job.runner) {
                html += `${job.runner.description} (<a href="https://gitlab.invenia.ca/admin/runners/${job.runner.id}">#${job.runner.id}</a>)`
            } else {
                html += "<i>No runner info</i>";
            }
            html += `<h3>Error messages detected:</h3>`;
            if (patterns_pre_filter.length === 0) {
                html += `<i>No known error pattern was found. You can add patterns <a href="https://gitlab.invenia.ca/invenia/gitlab-dashboard/-/blob/master/find_patterns_in_logs.py" target="_blank">here</a>.</i>`;
            } else {
                html += `<ul>`;
                for (let pattern of patterns_pre_filter) {
                    html += `<li>`;
                    // The tooltip has a hardcoded width (see CSS).
                    // What if the error message is too long to fit in the given width?
                    // a) If error message is multi-line, use `pre`, i.e. display newlines
                    //    as they are in the error message, long lines will overflow
                    //    and user will have to scroll right to see those lines in full
                    // b) Else (error message is a single line), use `div`, i.e. allow the
                    //    content to be rendered with line breaks in order to fit in the
                    //    given width.
                    // This makes things more readable for either case.
                    let html_tag = pattern.matched_group.includes("\n") ? 'pre' : 'div';
                    html += `<${html_tag} class="error-message">${escapeHtml(pattern.matched_group)}</${html_tag}>`;
                    html += `</li>`;
                }
                html += `</ul>`;
            }
            html += `<h3>Dependency changes:</h3>`;
            html += render_dependencies_diff_full(dep_diff);
            html += `</span></span>`;

            html += job_status_icon(job);
            html += `</span>`;
            html += `</span>`;
            html += `</td>`;
        }
        if (state.display_errors) {
            html += `<td class="error-messages">`;
            html += `<ul>`;
            if (all_patterns.length === 0 && job.status == "failed") {
                html += `<li>`;
                html += `<span class="tooltip dashboard-error-message">`;
                html += `?`
                html += `</span>`;
                html += `</li>`;
            } else {
                for (let pattern of patterns_filtered) {
                    html += `<li>`;
                    html += `<span class="tooltip error-message">`;
                    html += limit_string(remove_python_error_prefix(escapeHtml(pattern.matched_group)), length=ERROR_STRING_DISPLAY_LIMIT);
                    html += `</span>`;
                    html += `</li>`;
                }
            }
            html += `</ul>`;
            html += `</td>`;
        }
        if (state.display_dependencies) {
            html += `<td class="dependencies">`;
            if (previous_job) {
                let dep_diff = dependencies_diff(dependencies_previous_job, dependencies);
                html += `<div class="tooltip">`;
                // html += `<span class="dependencies-short">${render_dependencies_diff_short(dep_diff)}</span>`;
                html += `<div class="dependencies-short">${render_dependencies_diff_pretty(dep_diff)}</div>`;
                // html += `<div class="dependencies-short">${render_dependencies_diff_full(dep_diff)}</div>`;
                html += `</div>`;
            }
            html += `</td>`;
        }
        if (state.display_runner) {
            html += `<td class="runner-name">`;
            if (job.runner && job.runner.description && job.runner.id) {
                html += shorten_runner_name(job.runner);
            }
            html += `</td>`;
        }
        html += `</tr>`;
    } else {
        html = '';
    }
    return html;
}

function emojize(text) {
    return text
        // .replaceAll(/linux/gi, '<span title="Linux">🐧</span>')
        // .replaceAll(/mac/gi, '<span title="Mac">🍏</span>') // 
        // .replaceAll(/nightly/gi, '<span title="Nightly">🌙</span>') // ☪☾✩☽🌙🌚🌕
        // .replaceAll(/High-Memory/gi, '<span title="High-Memory">💾</span>') // 💾
        // .replaceAll(/Documentation/gi, '<span title="Documentation">📜</span>') // 📜📄📝

        // .replaceAll(/linux/gi, '🐧')
        // .replaceAll(/mac(os)?/gi, '🍏') // 
        // .replaceAll(/nightly/gi, '🌙') // ☪☾✩☽🌙🌚🌕
        // .replaceAll(/High-Memory/gi, '💾') // 💾
        // .replaceAll(/Documentation/gi, '📜') // 📜📄📝
        // .replaceAll(/(32-bit|i686)/gi, '32')
        // .replaceAll(/(64-bit|x86_64)/gi, '64')

        .replaceAll(/linux/gi, '<span class="emoji">🐧</span>')
        .replaceAll(/mac(os)?/gi, '<span class="emoji">🍏</span>') // 
        .replaceAll(/nightly/gi, '<span class="emoji">🌙</span>') // ☪☾✩☽🌙🌚🌕
        .replaceAll(/High-Memory/gi, '<span class="emoji">💾</span>') // 💾
        .replaceAll(/Documentation/gi, '<span class="emoji">📜</span>') // 📜📄📝
        .replaceAll(/(i686|32-bit)/gi, '32')
        .replaceAll(/(x86_64|64-bit)/gi, '64')

        // .replaceAll(/((32-bit|i686)\s*)+/gi, '<span title="32-bit (i686)">32</span>')
        // .replaceAll(/((64-bit|x86_64)\s*)+/gi, '<span title="64-bit (x86_64)">64</span>')
}

function shorten_job_name(text) {
    let no_punctuation = text.replaceAll(/[(),]/gi, '');
    let words = no_punctuation.split(' ');
    let words_shortened = words.map(function (word) {
        let emojized = emojize(word);
        if (emojized !== word) { // word has been emojized
            return emojized;
        } else {
            // replace word by its first letter
            let abbreviated = emojized.replaceAll(/([a-zA-Z_.-]{1})[a-zA-Z_.-]*/gi, '$1');
            return abbreviated;
        }
    });
    return words_shortened.join('');
}

function shorten_runner_name(runner) {
    let words = runner.description.split('-');
    let words_shortened = words.map(function (word) {
        let abbreviated = word.replaceAll(/([a-zA-Z_.-]{1})[a-zA-Z_.-]*/gi, '$1');
        return abbreviated;
    });
    return words_shortened.join('-') + `#${runner.id}`;
}

function render_dates_header(table, timeline_start) {
    let dates_header = table.createTHead();
    // Days row
    let days_row = dates_header.insertRow();
    let dates_utc = dates_since(timeline_start);
    let dates = dates_utc.map(display_date);
    let today = dates.pop();
    let first_date = true;
    for (let date of dates){
        let month_prefix = '';
        if (first_date || date.getDate() === 1){ 
            month_prefix = date.toLocaleString('default', { month: 'short' });
        }
        first_date = false;
        addTH(days_row, `${month_prefix} ${date.getDate()}`);
    }
    month_prefix = today.toLocaleString('default', { month: 'short' });
    addTH(days_row, `${month_prefix} ${today.getDate()} (last night)`, class_list=["today"]);
    addTH(days_row, `
        <span class="tooltip">updated ${time_since(last_updated)} ago
            <span><span class="tooltiptext">${last_updated.toISOString()}</span></span>
        </span>
    `, class_list=["last-updated-time"]);
}

function render_project_issues(issues) {
    if (issues.length > 0) {
        let issues_html = issues.map(i => `<li><a href="${i.web_url}" target="_blank">${i.ref} ${i.title}</a></li>`).join(``);
        return `<ul>${issues_html}</ul>`;
    } else {
        return `<i>none.</i>`;
    }
}

function render_project_info(project) {
    html = `
        <span class="project-info">
        <span class="tooltip">`;
    if (is_in_prod(project)) {
        html += `<span class="prod">prod</span>`;
    }
    html += `
            <a href="${project.metadata.web_url}" target="_blank">${project.metadata.name}</a>
            <span class="tooltiptext">
                <div>
                    <a href="${project.metadata.web_url}/-/issues?label_name=nightly" target="_blank">Nightly issues:</a>
                    ${render_project_issues(project.issues)}
                </div>
                <div>
                    <a href="${project.metadata.web_url}/-/issues" target="_blank">All issues</a>
                </div>
            </span>
        </span>
        </span>`;
    return html;
}

function render_project_pipelines() {
    let state = window.history.state;
    
    let oldest_pipeline_date = get_oldest_pipeline_date(projects);
    let min_timeline_start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - DAYS_AGO);
    let timeline_start = new Date(Math.max(oldest_pipeline_date, min_timeline_start));
    
    let projects_sorted = sort_projects_by_pipeline_status(projects, timeline_start);

    let table = document.getElementById('results-table');
    table.innerHTML = '';

    render_dates_header(table, timeline_start);

    let table_body = document.createElement('tbody');
    table.appendChild(table_body);
    for (let project of projects_sorted) {
        if (!has_pipelines_after_date(project, timeline_start)) {
            continue;
        }
        let is_prod = eis_dependencies.includes(project.metadata.name.replace(/\.jl$/, ""));
        if (state.repos == "prod" && !is_in_prod(project) ||
            state.repos == "non-prod" && is_in_prod(project) ) {
            continue;
        }

        let row = table_body.insertRow();

        // add table row
        let dates = dates_since(timeline_start);
        let pipeline_previous_day = null;
        for (date of dates){
            let pipelines = get_pipelines_for_date(project, date);
            let cellValue = '';
            if (pipelines.length == 0) {
                cellValue = '<em title="no pipeline">-</em>';
                pipeline_previous_day = null;
            } else if (pipelines.length > 1) {
                // TODO support deps diff for multiple pipelines
                cellValue = '<em>multiple<br>pipelines</em>';
                cellValue = pipelines.map(pipeline => render_pipeline(pipeline, undefined, project)).join('<br>');
                pipeline_previous_day = null;
            } else {
                let pipeline = pipelines[0];
                cellValue = render_pipeline(pipeline, pipeline_previous_day, project);
                pipeline_previous_day = pipeline;
            }
            let class_list = (date === dates[dates.length-1]) ? ["today"] : [];
            addCell(row, cellValue, class_list);
        }

        addCell(row, render_project_info(project), class_list=["sticky-right"]);
    }

    table.parentNode.scrollLeft = 1000000;
}

//=================================
//      State management
//=================================

function state_to_search_string(state) {
    // TODO remove fields which have the default value
    let search_string = new URLSearchParams(remove_defaults_and_null_values(state)).toString();
    return search_string === "" ? window.location.pathname : `?${search_string}`;
}

function parse_boolean(str, default_value) {
    if (str === 'true') {
        return true;
    } else if (str === 'false') {
        return false
    } else {
        return default_value;
    }
}

function update_state_from_url() {
    let search_params = new URLSearchParams(window.location.search);
    let state = {
        "repos": search_params.get('repos') || DEFAULTS['repos'],
        "search": search_params.get('search') || DEFAULTS['search'],
        "display_errors": parse_boolean(search_params.get('display_errors'), DEFAULTS['display_errors']),
        "display_dependencies": parse_boolean(search_params.get('display_dependencies'), DEFAULTS['display_dependencies']),
        "display_runner": parse_boolean(search_params.get('display_runner'), DEFAULTS['display_runner']),
        "display_job_names": parse_boolean(search_params.get('display_job_names'), DEFAULTS['display_job_names']),
        "display_jobs_failed": parse_boolean(search_params.get('display_jobs_failed'), DEFAULTS['display_jobs_failed']),
        "display_jobs_failed_allow_failure": parse_boolean(search_params.get('display_jobs_failed_allow_failure'), DEFAULTS['display_jobs_failed_allow_failure']),
        "display_jobs_passed": parse_boolean(search_params.get('display_jobs_passed'), DEFAULTS['display_jobs_passed']),
        "display_jobs_other": parse_boolean(search_params.get('display_jobs_other'), DEFAULTS['display_jobs_other']),
    };
    console.log('state', state);
    let res = window.history.replaceState(state, "", state_to_search_string(state));
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_state_from_user_inputs() {
    let state = {
        repos: document.querySelector('input[name="repos"]:checked').value,
        search: document.querySelector('#search').value,
        display_errors: document.querySelector('#display-errors').checked,
        display_dependencies: document.querySelector('#display-dependencies').checked,
        display_runner: document.querySelector('#display-runner').checked,
        display_job_names: document.querySelector('#display-job-names').checked,
        display_jobs_failed: document.querySelector('#display-jobs-failed').checked,
        display_jobs_failed_allow_failure: document.querySelector('#display-jobs-failed-allow-failure').checked,
        display_jobs_passed: document.querySelector('#display-jobs-passed').checked,
        display_jobs_other: document.querySelector('#display-jobs-other').checked,
    }
    console.log('state', state);
    window.history.pushState(state, "", state_to_search_string(state));
    update_results_from_state();
}

// When the back button is used
window.onpopstate = function(event) {
    console.log('state', window.history.state);
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_user_inputs_from_state() {
    let state = window.history.state;
    document.getElementById(`repos-${state.repos}`).checked = true;
    document.getElementById(`search`).value = state.search;
    document.getElementById(`display-errors`).checked = state.display_errors;
    document.getElementById(`display-dependencies`).checked = state.display_dependencies;
    document.getElementById(`display-runner`).checked = state.display_runner;
    document.getElementById(`display-job-names`).checked = state.display_job_names;
    document.getElementById(`display-jobs-failed`).checked = state.display_jobs_failed;
    document.getElementById(`display-jobs-failed-allow-failure`).checked = state.display_jobs_failed_allow_failure;
    document.getElementById(`display-jobs-passed`).checked = state.display_jobs_passed;
    document.getElementById(`display-jobs-other`).checked = state.display_jobs_other;
}

function update_results_from_state() {
    render_project_pipelines();
}

//=================================
//            Main
//=================================

let table = document.getElementById('results-table');

table.parentNode.classList.add("loading");

// Explicitly fetch the .gz files and decompress in JavaScript.
// This wouldn't be needed if the server respected the `accept-encoding: gzip`
// header set by the browser and sent back the gz files to be decompressed by the browser,
// but somehow that doesn't work. https://gitlab.invenia.ca/invenia/gitlab-dashboard/-/issues/8
Promise.all([
    fetch('combined_small.json.gz'),
    fetch('extracted_info.json.gz'),
    fetch('last_updated.json.gz'),
    fetch('eis_dependencies.json.gz'),
]).then(function (responses) {
    if (responses.some(r => r.status !== 200)) {
        throw 'fetching json failed (see dev console).';
    }
    // Get a JSON object from each of the responses
    return Promise.all(responses.map(function (response) {
        return response.arrayBuffer().then(function(buffer) {
            let gunzip = new Zlib.Gunzip(new Uint8Array(buffer));
            let decompressed = gunzip.decompress();
            let text = new TextDecoder().decode(decompressed);
            return JSON.parse(text);
        })
    }));
}).then(function (data) {
    table.parentNode.classList.remove("loading");
    projects = data[0];
    projects_dict = Object.assign({}, ...projects.map(p => ({[p.metadata.name]: p})));
    extracted_info = data[1];
    last_updated = new Date(data[2]);
    eis_dependencies = data[3];
    if (!isSameDay(get_newest_pipeline_date(projects), Date.now())) {
        show_error(`WARNING: pipelines for the most recent day(s) are missing. This is likely due to a dashboard build failure (see <a href="https://gitlab.invenia.ca/invenia/gitlab-dashboard/-/pipelines">here</a>).`);
    }
    update_state_from_url();
}).catch(function (error) {
    table.parentNode.classList.remove("loading");
    show_error(`ERROR: ${error}`);
    throw error;
});
