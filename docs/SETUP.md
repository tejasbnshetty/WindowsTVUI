# Couch UI: setup guide

Couch UI is a fullscreen launcher you show on a TV (HDMI) and control from an iPhone over your home Wi-Fi.

**It only runs when you start it, and stops when you exit it.** There is no autostart, no login item, no scheduled
task, no background service, no tray icon and no watchdog. After you exit, nothing of it is left running.

Contents: [Build](#1-build-the-installer) · [Install](#2-install) · [Portable](#3-portable-exe) · [Run](#4-run-and-pair) ·
[Exit](#5-exit) · [Config, data, logs](#6-config-data-and-logs) · [Fixed IP](#7-reserve-a-fixed-ip-in-your-router) ·
[Sleep](#8-keep-the-laptop-awake-while-it-runs) · [TV settings](#9-tv-settings) · [Troubleshooting](#10-troubleshooting)

---

## 1. Build the installer

Needs Windows 10/11 (x64), Node.js 20+ and an internet connection for the first build (electron-builder downloads its NSIS tools once).

```powershell
npm install
npm run dist
```

Output in `release\`:

| File | What it is |
| --- | --- |
| `Couch-UI-Setup-0.1.0.exe` | NSIS installer: Desktop + Start Menu shortcut "Couch UI", Windows Firewall rule |
| `Couch-UI-Portable-0.1.0.exe` | Single portable `.exe`, nothing is installed |

Other scripts: `npm run pack` builds just the unpacked app in `release\win-unpacked\` (fast, for testing),
`npm run icon` regenerates the placeholder icon in `build\`, `npm test` runs the unit tests.

The builds are **not code-signed**. The first time you run either file Windows SmartScreen may say
*"Windows protected your PC"*: click **More info → Run anyway**. That is expected for unsigned software.

## 2. Install

1. Double-click `Couch-UI-Setup-0.1.0.exe`.
2. Windows asks for **administrator permission once**, at install time only. This is what lets the installer add the
   firewall rule (below). Couch UI itself always runs as a normal user.
3. Pick the install folder (or keep the default) and finish. Shortcuts named **Couch UI** appear on the Desktop and
   in the Start Menu.

**Firewall rule.** The installer adds one inbound rule named `Couch UI`, for the installed program only, restricted to
**Private networks**. It covers the phone remote (TCP 8787) and the `couchui.local` name announcement (UDP 5353). The
uninstaller removes it. Nothing is opened on Public networks. To check it:

```powershell
netsh advfirewall firewall show rule name="Couch UI"
```

Your Wi-Fi must be set to the **Private** profile (Settings → Network & internet → Wi-Fi → your network →
*Network profile type: Private*). On a Public profile the rule does not apply and the phone will not connect.

**Uninstall:** Settings → Apps → Couch UI → Uninstall. This removes the app, shortcuts and firewall rule. It keeps
your data folder (see section 6) so a reinstall remembers your phones; delete that folder by hand to wipe everything.

## 3. Portable exe

Run `Couch-UI-Portable-0.1.0.exe` from anywhere. Nothing is installed and no firewall rule is created, so Windows shows
its normal *"Allow access"* prompt the first time: **tick Private networks only** and click Allow.

The portable build unpacks itself to a new temporary folder on every launch, so Windows may ask again each time. To avoid
that, add two port-based rules once (run PowerShell **as administrator**):

```powershell
netsh advfirewall firewall add rule name="Couch UI portable (remote)" dir=in action=allow protocol=TCP localport=8787 profile=private
netsh advfirewall firewall add rule name="Couch UI portable (mDNS)"   dir=in action=allow protocol=UDP localport=5353 profile=private
```

Remove them later with `netsh advfirewall firewall delete rule name="Couch UI portable (remote)"` (and the same for
`(mDNS)`). If you changed the port in `config.json`, use that port instead of 8787.

## 4. Run and pair

1. Connect the laptop to the TV by HDMI and make sure the TV shows the laptop's screen (Win+P → *Extend* or
   *Second screen only*; see section 9).
2. Double-click **Couch UI** on the Desktop. The launcher goes fullscreen.
3. In the bottom-right corner it shows the status line (*Wi-Fi connected*), the address, a QR code and a PIN:
   - `http://192.168.x.x:8787`, the address that always works, and
   - `http://couchui.local:8787`, a name that keeps working if the laptop's IP changes.
4. On the iPhone (same Wi-Fi) scan the QR code or type either address in Safari, enter the PIN.
5. Optional: Safari → Share → **Add to Home Screen** for a full-screen remote.

The PIN and QR only show while pairing is open (first run, or after you press **P** on the laptop / tap
*Pair new device* on an already-paired phone). Once a phone pairs they disappear, and that phone stays paired across
restarts. iOS may ask *"Allow … to find and connect to devices on your local network"*: allow it, it is needed for
`couchui.local`.

## 5. Exit

Any of these quits the app completely (stops the servers, frees the port, withdraws `couchui.local`, releases the
keep-awake request):

- Press **Esc** on the laptop keyboard while the launcher is in front, or
- On the phone: **Settings → Exit launcher**, then tap **Tap again to exit**.

To confirm nothing is left running, open Task Manager and look for **Couch UI** (or run
`tasklist /FI "IMAGENAME eq Couch UI.exe"`): after exit it lists nothing.

## 6. Config, data and logs

Everything lives in `%APPDATA%\Couch UI\` (paste that into Explorer's address bar):

| Path | Purpose |
| --- | --- |
| `config.json` | **Your settings.** Created on first run from the defaults; never overwritten by updates. |
| `devices.json` | Remembered phones (only hashes of their tokens, never the tokens). |
| `settings.json` | The display chosen from the phone's Settings tab. |
| `logs\couch-ui.log` | Log file. Rotates at 1 MB and keeps the last 5 files (`couch-ui.1.log` … `couch-ui.4.log`). |

Edit `config.json` with Notepad and restart Couch UI to apply:

```jsonc
{
  "port": 8787,          // phone remote port
  "display": "auto",     // "auto" = the screen it started on, "primary", a display id, or part of a monitor's name
  "tiles": [
    { "id": "youtube", "label": "YouTube", "color": "#ef4444", "type": "url", "target": "https://www.youtube.com/tv" },
    { "id": "vlc", "label": "VLC", "color": "#f97316", "type": "exe", "target": "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" }
  ]
}
```

(The real file must be plain JSON: no comments. Remember to double the backslashes in Windows paths.)

Logs never contain the PIN or any token. If something misbehaves, the newest lines of `couch-ui.log` are the first
place to look.

## 7. Reserve a fixed IP in your router

`couchui.local` already survives IP changes, but a fixed address makes the plain IP URL and bookmarks reliable too.
This is called a **DHCP reservation** (or "static lease" / "address reservation").

1. Find the laptop's Wi-Fi MAC address: `ipconfig /all`, look at the **Wi-Fi** adapter's *Physical Address*.
2. **Important:** turn off Windows' random address for that network, otherwise the MAC changes and the reservation
   stops matching: Settings → Network & internet → Wi-Fi → *your network* → **Random hardware addresses: Off**,
   then reconnect to the Wi-Fi.
3. Open your router's admin page (often `192.168.1.1` or `192.168.0.1`), go to *LAN / DHCP / Address Reservation*.
4. Add an entry: laptop MAC → an address **outside** the router's normal DHCP pool (for example `192.168.1.50` if the
   pool is `.100`–`.200`), save, and reconnect the laptop to the Wi-Fi.
5. Check with `ipconfig`. The launcher shows the new address; re-scan the QR code once if the phone had the old one.

## 8. Keep the laptop awake while it runs

While the launcher runs it asks Windows to keep the **display** awake (a power request that is released on exit).
Windows can still sleep from the lid, the power button, or an explicit Sleep, so for a laptop that drives a TV also set:

- Settings → System → Power & battery → Screen and sleep → *When plugged in, put my device to sleep after* → **Never**.
- Close-lid behaviour: Control Panel → Power Options → *Choose what closing the lid does* → **When plugged in: Do
  nothing**. Needed if you want the lid shut while the TV is the only screen.

If the laptop does sleep and wakes later, Couch UI notices the resume, re-checks the network, re-binds its server if
needed, re-announces `couchui.local` and re-detects displays. The phone reconnects by itself within a few seconds.

## 9. TV settings

Wording differs per brand; look for these:

- **Just Scan / Screen Fit / Full Pixel / Dot by Dot / "Original"** for the aspect ratio. Without it the TV zooms
  and crops the picture (overscan), cutting off the tile edges and the PIN panel. This is the most important setting.
- **PC mode** for the HDMI input (on many TVs: rename the input to "PC", or pick the *PC* / *Game* picture mode). It
  gives sharp text (full 4:4:4 colour) and the lowest latency.
- **Turn off** motion smoothing / frame interpolation, noise reduction and dynamic contrast.
- **60 Hz:** Windows Settings → System → Display → *Advanced display* → choose **60 Hz** for the TV. At 4K, 60 Hz needs
  an HDMI 2.0 cable and port; if the picture flickers or drops out, use 1080p at 60 Hz or 4K at 30 Hz.
- **HDR off** (Windows Settings → System → Display → HDR) unless you want it for video, as it dims normal desktop colours.
- **Display scaling** 100 %–150 % so the launcher text is readable from the couch.
- **Win+P:** *Extend* keeps the laptop screen usable. Then use the phone's **Settings → Display** to put the launcher on
  the TV. *Second screen only* makes the TV the only screen (required if the lid is closed).

## 10. Troubleshooting

| Problem | What to try |
| --- | --- |
| Phone cannot open the page | Same Wi-Fi? Laptop network profile set to **Private**? Router "client/AP isolation" off? Firewall rule present (section 2)? Try the IP address instead of `couchui.local`. |
| `couchui.local` does not open but the IP does | Allow the iOS local-network prompt; some routers/VPNs block mDNS; use the IP address (give the laptop a fixed IP, section 7). |
| Red banner "Port 8787 is already in use" | Another program (or another copy of Couch UI) has the port. Close it, or change `"port"` in `config.json` and restart. |
| Launcher does not take keyboard focus after Home | Windows sometimes refuses; the launcher still appears and the phone still navigates it. See the log for which method worked. |
| Status line says *No network connection* | Wi-Fi dropped. The launcher recovers by itself when it returns; phones reconnect automatically. |
| Phone says "This phone isn't paired any more" | Pairing was reset ("Forget all devices"). Press **P** on the laptop and enter the new PIN. |
| Need to start over | Exit Couch UI, delete `%APPDATA%\Couch UI\`, start again. |
