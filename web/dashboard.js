
let pp;

let body = document.getElementsByTagName('body')[0];

function add_days(date, days) {
    var result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function get_oldest_pipeline_date(projects) {
    let dates = projects.flatMap(function(p) {
        return p.pipelines.slice(-1).flatMap(function(pip) {
            return pip.created_at ? [new Date(pip.created_at)] : [];
        })
    });
    console.log(dates);
    let min_date = new Date(Math.min.apply(null, dates));
    return min_date;
}

function has_pipelines_after_date(project, date) {
    return project.pipelines.some(p => date_without_time(new Date(p.created_at)).getTime() > date.getTime());
}

function get_pipelines_for_date(project, date) {
    return project.pipelines.filter(p => date_without_time(new Date(p.created_at)).getTime() === date.getTime());
    // for (let pipeline of project.pipelines) {
    //     console.log(pipeline.created_at)
    //     if date_without_time(pipeline.crea)
    // }
}

function date_without_time(date) {
    let res = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    return res;
}

function dates_since(start_datetime) {
    // console.log('start_datetime', start_datetime);
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

function to_html_node(text_or_node) {
    if (typeof text_or_node === "string") {
        return document.createTextNode(text_or_node);
    } else {
        return text_or_node;
    }
}

function addTH(row, text_or_node) {
    let th = document.createElement("th");
    // th.appendChild(to_html_node(text_or_node));
    th.innerHTML = text_or_node;
    row.appendChild(th);
}

function addCell(row, text_or_node) {
    let cell = row.insertCell();
    cell.innerHTML = text_or_node;
    // cell.appendChild(to_html_node(text_or_node));
}

function render_pipeline(pipeline) {
    let cellValue;
    if (pipeline.status === "success") {
        cellValue = `<a href="${pipeline.web_url}"><span title="success">✓</span></a>`;
    } else {
        let jobs = project.failed_pipelines[pipeline.id].jobs;
        console.log(jobs);
        let failed_jobs = jobs.filter(j => j.status === "failed");
        if (failed_jobs.length > 0) {
            cellValue = failed_jobs.map(render_job).join("<br>");
        } else {
            cellValue = pipeline.status;
        }
        // cellValue = `<a>${pipeline.status}</a>`;
    }
    return cellValue;
}

function render_job(job) {
    console.log(job)
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

function display_project_pipelines(projects) {
    pp = projects;
    // console.log(projects);
    // console.log(projects[0]);

    let oldest_pipeline_date = get_oldest_pipeline_date(projects);
    console.log('oldest_pipeline_date', oldest_pipeline_date);
    let a_month_ago = new Date(new Date().getFullYear(), new Date().getMonth() - 1, new Date().getDate() );
    let timeline_start = new Date(Math.max(oldest_pipeline_date, a_month_ago));
    console.log('max', oldest_pipeline_date, a_month_ago, timeline_start);

    let table = document.getElementById('pipeline-table');

    // Dates header
    let dates_header = table.createTHead();
    let row = dates_header.insertRow();
    addTH(row, "");
    for (date of dates_since(timeline_start)){
        addTH(row, `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`)
    }

    let table_body = document.createElement('tbody');
    table.appendChild(table_body);
    for (project of projects) {
        // if (project.metadata.id !== 207) continue;
        if (!has_pipelines_after_date(project, timeline_start)) {
            continue;
        }

        let row = table_body.insertRow();

        addCell(row, `<a href="${project.metadata.web_url}/-/pipelines">${project.metadata.name}</a>`);

        // console.log('dates', dates_since(timeline_start));
        // add table row
        for (date of dates_since(timeline_start)){
            // console.log('date', date)
            let pipelines = get_pipelines_for_date(project, date);
            let cellValue = '';
            if (pipelines.length == 0) {
                cellValue = '<em title="no pipeline">-</em>';
            } else if (pipelines.length > 1) {
                cellValue = '<em>multiple<br>pipelines</em>';
                cellValue = pipelines.map(render_pipeline).join('<br>');
            } else {
                let pipeline = pipelines[0];
                // console.log('pipeline', pipeline)
                cellValue = render_pipeline(pipeline);
            }
            addCell(row, cellValue);
            // add table data
            // TODO: what to do with multiple pipelines during the same day? Show warning message
        }
    }


}

fetch('combined.json')
  .then(response => response.json())
  .then(display_project_pipelines);

