# Next Steps For User

## Because Git Is Not Available In This Session

To finish the GitHub side, do these steps on your machine where GitHub is already connected:

1. Install Git for Windows if it is not already installed.
2. Open PowerShell in the project folder.
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\deploy\publish_to_github.ps1
```

That will:

- initialize the repository if needed
- commit the current files
- connect `origin` to `https://github.com/maknud7/blindleiadarts.git`
- push `main`
- create and push `develop`

## Then In GitHub

1. Add the secrets and variables listed in `docs/handover/GITHUB_DEPLOY_SETUP.md`.
2. Run the `Run Database Migrations` workflow for `test`.
3. Push or merge changes into `develop` to trigger the first test deploy.
4. After approval, run the production migration and production deploy workflows.
