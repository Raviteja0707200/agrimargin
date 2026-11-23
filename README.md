# AgriMargin on Render (with sync)

Files: `server.js`, `index.html`, `package.json`, `render.yaml`.

## Deploy
1. Push these files to the root of a new GitHub repo.
2. Render -> New -> Blueprint -> pick the repo. Enter `APP_PASSWORD` (min 8 characters) when asked. This is your first password.
3. Open the URL and sign in on each device. Data syncs automatically.

## Do this right after your first sign-in
Settings -> Sync across devices -> **Create recovery key**. Save it in a password manager. It is shown once and is the only way to reset a forgotten password from the login screen.

## Passwords
- **Change password:** Settings -> Change password. Other devices must sign in again.
- **Forgot password:** login screen -> "Forgot password?" -> enter the recovery key and a new password. A fresh recovery key is issued; save it.
- **Lost the password AND the key:** in Render set `RESET_AUTH=true`, redeploy, sign in with your original `APP_PASSWORD`, then **remove `RESET_AUTH`** (otherwise it clears the stored password every boot). Your records are not touched.
- After the first change/reset, the password is stored (scrypt-hashed) in `auth.json` next to your data and `APP_PASSWORD` is ignored until `RESET_AUTH` is used.

## Signing out
Sign out uploads pending changes, then **erases this device's local copy**. The data stays on the server and downloads again at next sign-in. If changes could not be uploaded (offline) you are warned before they are discarded.
Expired sessions do not erase anything - you are just asked to sign in again.

## Storage
- Starter plan + persistent disk (`/var/data`) keeps server data across restarts.
- Free plan: remove the `disk:` and `DATA_DIR` lines. The server forgets its data on restart (including a changed password and recovery key - `APP_PASSWORD` applies again) but each device keeps a full copy and re-uploads on the next sync.
- Back up regularly anyway: Settings -> Export JSON.
