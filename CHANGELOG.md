# Changelog

## 1.9.0
- **Pause session** in the Section panel: everyone gets 30 seconds, the HQ saves the session and closes. Next start lists the saved sessions; resuming brings back the same team, incident, access code, log, evidence, orders, tasks and roles.
- Analysts reconnect by themselves after a pause, or rejoin without the code (rejoin record kept 72 hours).
- Optional passphrase at the start of a session: the saved file is encrypted with AES 256 GCM (scrypt key). Without it, the file is only compressed.
- Automatic checkpoint a few seconds after every change, and on Ctrl+C or window close, so a crash loses nothing the devices cannot push back.
- The H clock keeps running through a pause; the log records the pause and the resume.
- White Cell console saved and resumed too. Scheduled injects that came due during the pause are held for **Send now** or **Cancel**. **End exercise** deletes the White Cell file. An HQ that comes back on a new address is merged with its old entry.
- **End session** now also deletes the saved file. New options `--resume`, `--passphrase`, `--no-save`.
- Orders already written or acknowledged no longer show again as banners after a reload.

## 1.8.0
- Requests for the White Cell are addressed to **WC** instead of 1UP, in the team app and the console.
- Members rejoin after a reload or a reopened tab without typing the code again (kept 12 hours, erased on leave, end of session or refusal).
- Findings journal links findings to common MITRE ATT&CK techniques.
- Host board: hosts from the findings with status Compromised, Isolated, Cleaned, Restored; SITREP and PowerPoint include it.

## 1.7.0
- White Cell finds HQs by scanning its subnet as well as by local name; **Scan network** button.
- RFCs can be addressed to the White Cell, which approves, rejects or asks for more information.
- SITREPs no longer go to the White Cell.
- **WC · White Cell** badge on every team device while the White Cell is connected; connection logged for the IC.

## 1.6.0
- White Cell mode: one console for several teams, answers RFIs, sends timed injects, measures response times, CSV export.
- RFIs gain an *Addressed to* field.

## 1.5.0
- Analysts join with name and callsign only; roles are given by the IC.
- Stand down restricted to IC and 2IC, with its own record list.

## 1.4.0
- IC first screen, warning order wording, task board prefilled with the section, personal task notification and acknowledgement.
- AAR: members edit only Sustain and Improve. Footer link to cyberlav.io. Mobile header fix.

## 1.3.0
- Intel role, incident ID synced from the IC, Declare moved after Orders, section roster filled from the people on the net.
- Orders, warning order and back brief to PDF. AAR proposals from members.

## 1.2.0
- Team asked at every start, command rights for IC and 2IC enforced by the HQ, back brief to the company commander.
- Local time for planning fields, tasks per PICERL phase, collapsible findings, findings journal to PDF with embedded files.

## 1.1.0
- Single executable, pre flight network check with one click fix, Section panel, readable access codes, End session.

## 1.0.0
- Field HQ: team sync over the local network, QR join, memory only session, reseed after restart.
