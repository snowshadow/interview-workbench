# Security

Interview Workbench processes resumes, interview transcripts, and API credentials.
Treat every deployment as sensitive.

## Supported deployment

The supported default is a single-user service bound to `127.0.0.1`.
Binding to a non-loopback address requires an access token and HTTPS through a
trusted reverse proxy. Do not expose the development server directly.

## Reporting

Do not include credentials, resumes, transcripts, or logs in public issues.
Report suspected vulnerabilities privately to the repository maintainers.

## Secrets

Credentials belong in `.env` or the process environment. They must never be
committed. Rotate a credential immediately if it may have entered a commit,
archive, screenshot, or public log.
