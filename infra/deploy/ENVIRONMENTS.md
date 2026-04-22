# Environment Strategy

## Goal

Run test and production as separate environments while using a single MySQL-compatible database if database count is limited.

## Hosting Targets

Suggested remote layout under `/www/blindleiadarts/`:

```text
/www/blindleiadarts/
  /prod
    /api
    /kiosk
    /screen
    /admin
    /static
  /test
    /api
    /kiosk
    /screen
    /admin
    /static
```

This keeps deployment paths clean and makes it easier to verify changes before promoting them to production.

## Database Strategy

Use one physical database with separate table prefixes per environment.

Recommended prefixes:

- production: `bd_prod_`
- test: `bd_test_`

Examples:

- `bd_prod_clubs`
- `bd_prod_tournaments`
- `bd_prod_matches`
- `bd_test_clubs`
- `bd_test_tournaments`
- `bd_test_matches`

Avoid mixing test and production rows in the same tables with an `environment` column. Prefix-separated tables are safer for kiosk and screen runtime behavior.

## Media Strategy

Keep uploaded media separated the same way:

```text
/www/blindleiadarts/prod/static/club-logos/
/www/blindleiadarts/prod/static/sponsors/
/www/blindleiadarts/prod/static/players/
/www/blindleiadarts/test/static/club-logos/
/www/blindleiadarts/test/static/sponsors/
/www/blindleiadarts/test/static/players/
```

Store only URLs or relative paths in the database.

## PHP Configuration Direction

Recommended environment settings:

- `APP_ENV=test` or `APP_ENV=prod`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASS`
- `DB_TABLE_PREFIX`
- `BASE_URL`
- `STATIC_BASE_URL`

The only required database difference between environments is the table prefix.

## Deployment Rule

Test should always be deployed and verified before copying the same change set into production.
