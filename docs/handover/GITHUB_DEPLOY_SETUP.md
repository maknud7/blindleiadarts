# GitHub Deploy Setup

## What Is Already In The Repo

The repository now includes:

- GitHub Actions for test deploy
- GitHub Actions for production deploy
- a manual migration workflow for the shared MySQL database
- release packaging for Domeneshop SFTP deployment
- generated PHP config per environment
- a first SQL migration with core platform tables

## Branch Flow

- `develop` -> deploys automatically to test
- `main` -> production code line
- production deploy is run manually from GitHub Actions

## GitHub Secrets To Add

Add these repository secrets under `Settings -> Secrets and variables -> Actions`:

- `SFTP_HOST` = `sftp.domeneshop.no`
- `SFTP_USERNAME` = `ingenting`
- `SFTP_PASSWORD` = SFTP password
- `DB_HOST` = `ingentingorg02.mysql.domeneshop.no`
- `DB_PORT` = `3306`
- `DB_NAME` = `ingentingorg02`
- `DB_USERNAME` = `ingentingorg02`
- `DB_PASSWORD` = database password

## GitHub Variables To Add

Add these repository variables:

- `TEST_BASE_URL`
- `TEST_STATIC_BASE_URL`
- `PROD_BASE_URL`
- `PROD_STATIC_BASE_URL`

Examples:

- `TEST_BASE_URL` -> URL for the test app root
- `TEST_STATIC_BASE_URL` -> URL for the test static folder
- `PROD_BASE_URL` -> URL for the production app root
- `PROD_STATIC_BASE_URL` -> URL for the production static folder

## One-Time Remote Folder Setup

Because the workflow uses SFTP-only upload, these folders should exist on the server before the first deploy:

```text
/www/blindleiadarts/test
/www/blindleiadarts/test/admin
/www/blindleiadarts/test/api
/www/blindleiadarts/test/kiosk
/www/blindleiadarts/test/packages
/www/blindleiadarts/test/screen
/www/blindleiadarts/prod
/www/blindleiadarts/prod/admin
/www/blindleiadarts/prod/api
/www/blindleiadarts/prod/kiosk
/www/blindleiadarts/prod/packages
/www/blindleiadarts/prod/screen
/www/blindleiadarts/test/static
/www/blindleiadarts/test/static/club-logos
/www/blindleiadarts/test/static/players
/www/blindleiadarts/test/static/sponsors
/www/blindleiadarts/prod/static
/www/blindleiadarts/prod/static/club-logos
/www/blindleiadarts/prod/static/players
/www/blindleiadarts/prod/static/sponsors
```

If you want, I can create them later as soon as the SFTP password starts being accepted.

## First Run Order

1. Push the repository to GitHub.
2. Create the `develop` branch if it does not already exist.
3. Add the secrets and variables above.
4. Run `Run Database Migrations` for `test`.
5. Push to `develop` and verify test deploy.
6. When test is approved, run the production migration workflow.
7. Run `Deploy Production` from GitHub Actions using `main`.

## Important Notes

- test and production share one physical database
- test uses prefix `bd_test_`
- production uses prefix `bd_prod_`
- production deployment is intentionally manual for safety
