
const DEFAULT_DAYS = 14;
const DEFAULT_NIGHTLY_USER = null;
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

let projects;

//=================================
//      Utility functions
//=================================

function remove_null_values(obj) {
    for (let propName in obj) {
        if (obj[propName] === null) {
            delete obj[propName];
        }
    }
    return obj;
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

function addTH(row, text_or_node) {
    let th = document.createElement("th");
    th.innerHTML = text_or_node;
    row.appendChild(th);
}

function addCell(row, text_or_node) {
    let cell = row.insertCell();
    cell.innerHTML = text_or_node;
}

function render_pipeline(pipeline) {
    let cellValue;
    if (pipeline.status === "success") {
        cellValue = `<a href="${pipeline.web_url}"><span title="success">✓</span></a>`;
    } else {
        let jobs = project.failed_pipelines[pipeline.id].jobs;
        let failed_jobs = jobs.filter(j => j.status === "failed");
        if (failed_jobs.length > 0) {
            cellValue = failed_jobs.map(render_job).join("<br>");
        } else {
            cellValue = pipeline.status;
        }
    }
    return cellValue;
}

function render_job(job) {
    return `<a href="${job.web_url}">${emojize(job.name)}</a>`;
}

function emojize(text) {
    return text
        .replaceAll(/[(),]/gi, '')
        .replaceAll(/linux/gi, '<span title="Linux">🐧</span>')
        .replaceAll(/mac/gi, '<span title="Mac">🍏</span>') // 
        .replaceAll(/nightly/gi, '<span title="Nightly">🌙</span>') // ☪☾✩☽🌙🌚🌕
        // .replaceAll(/((32-bit|i686)\s*)+/gi, '<span title="32-bit (i686)">32</span>')
        // .replaceAll(/((64-bit|x86_64)\s*)+/gi, '<span title="64-bit (x86_64)">64</span>')
}

function render_project_pipelines() {
    let state = window.history.state;
    console.log('state', state);
    
    let oldest_pipeline_date = get_oldest_pipeline_date(projects);
    let min_timeline_start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - state.days);
    let timeline_start = new Date(Math.max(oldest_pipeline_date, min_timeline_start));
    
    let projects_sorted = sort_projects_by_pipeline_status(projects, timeline_start);

    let table = document.getElementById('pipeline-table');
    table.innerHTML = '';

    // Dates header
    let dates_header = table.createTHead();
    let row = dates_header.insertRow();
    addTH(row, "");
    addTH(row, "");
    for (date of dates_since(timeline_start)){
        addTH(row, `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`)
    }

    let table_body = document.createElement('tbody');
    table.appendChild(table_body);
    for (project of projects_sorted) {
        // if (project.metadata.id !== 207) continue;
        if (!has_pipelines_after_date(project, timeline_start)) {
            continue;
        }
        if (state.nightly && project.nightly_user !== `nightly-${state.nightly}`) {
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
                cellValue = pipelines.map(render_pipeline).join('<br>');
            } else {
                let pipeline = pipelines[0];
                cellValue = render_pipeline(pipeline);
            }
            addCell(row, cellValue);
        }
    }
}

//=================================
//      State management
//=================================

function state_to_search_string(state) {
    let search_string = new URLSearchParams(remove_null_values(state)).toString();
    return search_string === "" ? "" : `?${search_string}`;
}

function update_state_from_url() {
    let search_params = new URLSearchParams(window.location.search);
    let state = {
        "nightly": search_params.get('nightly') || DEFAULT_NIGHTLY_USER,
        "days": search_params.get('days') || DEFAULT_DAYS,
    };
    history.replaceState(state, "", state_to_search_string(state));
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_state_from_user_inputs() {
    let nightly = document.querySelector('input[name="nightly"]:checked').value;
    let state = {
        nightly: nightly == "all" ? null : nightly,
        days: parseInt(document.querySelector('input[name="days"]:checked').value),
    }
    history.pushState(state, "", state_to_search_string(state));
    update_results_from_state();
}

window.onpopstate = function(event) {
    update_user_inputs_from_state();
    update_results_from_state();
}

function update_user_inputs_from_state() {
    let state = window.history.state;
    let nightly = state.nightly || "all";
    let days = state.days;
    document.getElementById(`nightly-${nightly}`).checked = true;
    document.getElementById(`days-${days}`).checked = true;
}

function update_results_from_state() {
    render_project_pipelines();
}

//=================================
//            Main
//=================================

// fetch('combined_december.json')
fetch('combined.json')
    .then(response => response.json())
    .then(function (response_json){
        projects = response_json;
        console.log('projects', projects);
        update_state_from_url();
    });
