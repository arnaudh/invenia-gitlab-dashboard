
# GitLab dashboard

The idea is to have a top-level view of nightly failures across all repos and across time, in order to help manage and investigate issues that come up during [nightly].

This repo is currently a simple proof of concept.

## Screenshots

All nightly failures for Dev repos this past month:

![Screenshot](screenshots/screenshot_full.png?raw=true)

Zoomed in

![Screenshot](screenshots/screenshot_zoom.png?raw=true)

All failed jobs are rendered as a link to the job.

## TODO

Some ideas to make this more useful:
- display the reason for failures, e.g timeout, actual error message(s)
- show links to issues. make it possible to easily assign a failure to an issue
- sorting / grouping / filtering of rows


## Run

1. Generate a [GitLab Personal Access Token](https://gitlab.invenia.ca/profile/personal_access_tokens) (checking the boxes for `read_user`, `read_api`, `read_repository`)

2. Download data from GitLab API

```
export GITLAB_ACCESS_TOKEN=<token>
./download_pipelines_info.sh
```

This will store files under `responses/`, and will also generate `web/combined.json` which combines all the useful data into one file.

3. Start a webserver to serve the `web/` directory

```
python3 -m http.server --directory web
```


4. Go to [http://localhost:8000/](http://localhost:8000/)

## Notes 

#### Useful GitLab API calls

[Projects](https://docs.gitlab.com/ee/api/projects.html)

- GET /projects
- GET /projects/:id

[Pipeline schedules](https://docs.gitlab.com/ee/api/pipeline_schedules.html)

- GET /projects/:id/pipeline_schedules

[Pipelines](https://docs.gitlab.com/ee/api/pipelines.html)

- GET /projects/:id/pipelines ?username
- GET /projects/:id/pipelines/:pipeline_id

[Jobs](https://docs.gitlab.com/ee/api/jobs.html)

- GET /projects/:id/pipelines/:pipeline_id/jobs
- GET /projects/:id/jobs
- GET /projects/:id/jobs/:job_id
- GET /projects/:id/jobs/:job_id/trace


Q: how many API calls are needed to get all the information we want?

```
R repos, D failed days, J failed jobs per pipeline

5     GET /projects (5 due to pagination)
R     GET /projects/:id/pipelines (+ pagination for days)
R*D   GET /projects/:id/pipelines/:pipeline_id/jobs
R*D*J GET /projects/:id/jobs/:job_id/trace
```



[nightly]: https://gitlab.invenia.ca/invenia/wiki/-/blob/master/dev/nightly.md
