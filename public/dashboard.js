
const DEFAULTS = {
    "nightly": "all", // nightly user
    "days": 7,
    "search": "", // search filter
    "display_jobs": true,
    "display_errors": true,
}

const USERS_INFO = {
    "nightly-rse": {
        "name": "White Horse",
        "avatar": "images/nightly-rse.png"
    },
    "nightly-dev": {
        "name": "Dark Horse",
        "avatar": "images/nightly-dev.jpg"
    },
}
const ERROR_STRING_DISPLAY_LIMIT = 30;

let projects;
let patterns_in_logs;

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

function addTH(row, text_or_node, colspan=1, is_date_header=true) {
    let th = document.createElement("th");
    th.innerHTML = text_or_node;
    th.colSpan = colspan;
    if (is_date_header) {
        th.classList.add("date-header");
    }
    row.appendChild(th);
}

function addCell(row, text_or_node) {
    let cell = row.insertCell();
    cell.innerHTML = text_or_node;
}

function render_pipeline(pipeline, project) {
    let state = window.history.state;
    let cellValue;
    if (pipeline.status === "success") {
        cellValue = `<a href="${pipeline.web_url}"><span title="success">✓</span></a>`;
    } else if (pipeline.status === "failed") {
        if (state.display_jobs || state.display_errors) {
            let jobs = project.failed_pipelines[pipeline.id].jobs;
            let failed_jobs = jobs.filter(j => j.status === "failed");
            if (failed_jobs.length > 0) {
                cellValue = `<table class="pipeline-jobs">`;
                cellValue += failed_jobs.map(job => render_job(job, project)).join("");
                cellValue += `</table>`;
            } else {
                cellValue = `<a href="${pipeline.web_url}"><span title="${pipeline.status}">${pipeline.status}</span></a>`;
            }
        } else {
            cellValue = `<a href="${pipeline.web_url}"><span title="${pipeline.status}">${pipeline.status}</span></a>`;
        }
    } else {
        cellValue = `<a href="${pipeline.web_url}"><span title="${pipeline.status}">${pipeline.status}</span></a>`;
    }
    return cellValue;
}

function limit_string(s, length) {
    return s.length > length ? s.substring(0, length - 3) + "<span>…</span>" : s;
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

function render_job(job, project) {
    let state = window.history.state;
    let search_filter = state.search;
    let all_patterns = patterns_in_logs[project.metadata.id] && patterns_in_logs[project.metadata.id][job.id] || [];
    
    let patterns_deduplicated = remove_duplicates(all_patterns, ["matched_group"]); // remove addition patterns that have the same matched_group
    

    let show_job;
    let patterns_to_show;

    if (search_filter === "") {
        show_job = true;
        patterns_to_show = patterns_deduplicated;
    } else {
        let errors_matching_filter = patterns_deduplicated.filter(p => string_matches_filter(p.matched_group, search_filter));
        if (errors_matching_filter.length > 0) {
            show_job = true;
            patterns_to_show = errors_matching_filter;
        } else {
            show_job = string_matches_filter(job.name, search_filter);
            patterns_to_show = patterns_deduplicated;
        }
    }

    let html;
    if (show_job) {
        // html = `<table>`;
        html = `<tr>`;
        if (state.display_jobs) {
            html += `<td>`;
            html += `<span>`;
            html += `<span class="tooltip">`;
            html += `<a href="${job.web_url}">${emojize(job.name)}</a>`;
            // html += `<a href="${job.web_url}">${job.name}</a>`;
            html += `<span><span class="tooltiptext left">${job.name}</span></span>`;
            html += `</span>`;
            html += `</span>`;
            html += `</td>`;
        }
        if (state.display_errors) {
            html += `<td>`;
            html += `<ul>`;
            for (let pattern of patterns_to_show) {
                // html += ` <span>(${patterns.length})</span> `;
                html += `<li>`;
                html += `<span class="tooltip error-message">`;
                html += limit_string(pattern.matched_group, length=ERROR_STRING_DISPLAY_LIMIT);
                html += `<span><span class="tooltiptext center error-message">${pattern.matched_group}</span></span>`;
                html += `</span>`;
                html += `</li>`;
            }
        }
        html += `</ul>`;
        html += `</td>`;
        html += `</tr>`;
        // html += `</table>`;
    } else {
        html = '';
    }
    return html;
}

function emojize(text) {
    return text
        .replaceAll(/[(),]/gi, '')
        .replaceAll(/linux/gi, '<span title="Linux">🐧</span>')
        .replaceAll(/mac/gi, '<span title="Mac">🍏</span>') // 
        .replaceAll(/nightly/gi, '<span title="Nightly">🌙</span>') // ☪☾✩☽🌙🌚🌕
        .replaceAll(/High-Memory/gi, '<span title="High-Memory">💾</span>') // 💾
        .replaceAll(/Documentation/gi, '<span title="Documentation">📜</span>') // 📜📄📝
        // .replaceAll(/((32-bit|i686)\s*)+/gi, '<span title="32-bit (i686)">32</span>')
        // .replaceAll(/((64-bit|x86_64)\s*)+/gi, '<span title="64-bit (x86_64)">64</span>')
}

function render_dates_header(table, timeline_start) {
    let dates_header = table.createTHead();
    let date_row_months = dates_header.insertRow();
    addTH(date_row_months, "", colspan=2, is_date_header=false);
    let first_date = true;
    let dates_to_show_months = [];
    for (let date of dates_since(timeline_start)){
        if (first_date || date.getDate() === 1) {
            dates_to_show_months.push(date);
        }
        first_date = false;
    }
    for (let [i, date] of dates_to_show_months.entries()){
        let month = date.toLocaleString('default', { month: 'long' });
        let next_date = dates_to_show_months[i+1] || add_days(Date.now(), 1);
        let colspan = daysBetween(date, next_date);
        addTH(date_row_months, `${month}`, colspan)
    }
    let date_row_days = dates_header.insertRow();
    addTH(date_row_days, "", colspan=2, is_date_header=false);
    let dates = dates_since(timeline_start);
    let today = dates.pop();
    for (let date of dates){
        addTH(date_row_days, `${date.getDate()}`);
    }
    addTH(date_row_days, `<span class="today">${today.getDate()}</span>`);
}

function render_project_pipelines() {
    let state = window.history.state;
    
    let oldest_pipeline_date = get_oldest_pipeline_date(projects);
    let min_timeline_start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - state.days);
    let timeline_start = new Date(Math.max(oldest_pipeline_date, min_timeline_start));
    
    let projects_sorted = sort_projects_by_pipeline_status(projects, timeline_start);

    let table = document.getElementById('results-table');
    table.innerHTML = '';

    render_dates_header(table, timeline_start);

    let table_body = document.createElement('tbody');
    table.appendChild(table_body);
    for (let project of projects_sorted) {
        // if (project.metadata.id !== 207) continue;
        if (!has_pipelines_after_date(project, timeline_start)) {
            continue;
        }
        if (state.nightly !== "all"  && project.nightly_user !== `nightly-${state.nightly}`) {
            continue;
        }

        let row = table_body.insertRow();

        addCell(row, `<img src="${USERS_INFO[project.nightly_user].avatar}" class="avatar"/>`);
        addCell(row, `<a href="${project.metadata.web_url}/-/pipelines">${project.metadata.name}</a>`);

        // add table row
        for (date of dates_since(timeline_start)){
            let pipelines = get_pipelines_for_date(project, date);
            let cellValue = '';
            if (pipelines.length == 0) {
                cellValue = '<em title="no pipeline">-</em>';
            } else if (pipelines.length > 1) {
                cellValue = '<em>multiple<br>pipelines</em>';
                cellValue = pipelines.map(pipeline => render_pipeline(pipeline, project)).join('<br>');
            } else {
                let pipeline = pipelines[0];
                cellValue = render_pipeline(pipeline, project);
            }
            addCell(row, cellValue);
        }


        addCell(row, `<img src="${USERS_INFO[project.nightly_user].avatar}" class="avatar"/>`);
        addCell(row, `<a href="${project.metadata.web_url}/-/pipelines">${project.metadata.name}</a>`);

    }
}

//=================================
//      State management
//=================================

function state_to_search_string(state) {
    // TODO remove fields which have the default value
    let search_string = new URLSearchParams(remove_defaults_and_null_values(state)).toString();
    return search_string === "" ? window.location.pathname : `?${search_string}`;
}

function update_state_from_url() {
    let search_params = new URLSearchParams(window.location.search);
    let state = {
        "nightly": search_params.get('nightly') || DEFAULTS['nightly'],
        "days": search_params.get('days') || DEFAULTS['days'],
        "search": search_params.get('search') || DEFAULTS['search'],
        "display_errors": search_params.get('display_errors') == 'true' || DEFAULTS['display_errors'],
        "display_jobs": search_params.get('display_jobs') == 'true' || DEFAULTS['display_jobs'],
    };
    console.log('state', state);
    let res = window.history.replaceState(state, "", state_to_search_string(state));
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_state_from_user_inputs() {
    let state = {
        nightly: document.querySelector('input[name="nightly"]:checked').value,
        days: parseInt(document.querySelector('input[name="days"]:checked').value),
        search: document.querySelector('#search').value,
        display_errors: document.querySelector('#display-errors').checked,
        display_jobs: document.querySelector('#display-jobs').checked,
    }
    console.log('state', state);
    window.history.pushState(state, "", state_to_search_string(state));
    update_results_from_state();
}

window.onpopstate = function(event) {
    console.log('state', window.history.state);
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_user_inputs_from_state() {
    let state = window.history.state;
    document.getElementById(`nightly-${state.nightly}`).checked = true;
    document.getElementById(`days-${state.days}`).checked = true;
    document.getElementById(`search`).value = state.search;
    document.getElementById(`display-errors`).checked = state.display_errors;
    document.getElementById(`display-jobs`).checked = state.display_jobs;
}

function update_results_from_state() {
    render_project_pipelines();
}

//=================================
//            Main
//=================================

let table = document.getElementById('results-table');

table.classList.add("loading");

Promise.all([
    fetch('combined_small.json'),
    fetch('patterns_in_logs.json')
]).then(function (responses) {
    if (responses.some(r => r.status !== 200)) {
        throw 'fetching json failed (see dev console).';
    }
    // Get a JSON object from each of the responses
    return Promise.all(responses.map(function (response) {
        return response.json();
    }));
}).then(function (data) {
    table.classList.remove("loading");
    projects = data[0];
    patterns_in_logs = data[1];
    if (!isSameDay(get_newest_pipeline_date(projects), Date.now())) {
        show_error(`WARNING: pipelines for the most recent day(s) are missing. This is likely due to a dashboard build failure (see <a href="https://gitlab.invenia.ca/invenia/gitlab-dashboard/-/pipelines">here</a>).`);
    }
    update_state_from_url();
}).catch(function (error) {
    table.classList.remove("loading");
    show_error(`ERROR: ${error}`);
    throw error;
});
