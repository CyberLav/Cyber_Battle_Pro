# Field HQ guide

Options, network, certificates and security for `CBP-HQ.exe`. For the short procedure see [QUICKSTART.md](QUICKSTART.md).

## Requirements

- **Executable:** nothing to install. Windows 10/11 x64 (`CBP-HQ.exe`) or Linux x64.
- **From source:** Node.js 18 or newer, then `npm ci`.
- A local network for the section that is not the compromised network.

## Start

Double click `CBP-HQ.exe` (or `start-hq.bat` / `start-hq.sh` from source). Type `WC` as the team to run the White Cell console instead.

- Every start: type the team for this session (e.g. `CPT 1`). It gives the address `cpt1.local`. Then type the White Cell exercise code, or press Enter if there is no White Cell, and an optional passphrase for the saved session. If sessions were paused on this laptop, they are listed first so you can resume one.
- The incident ID and a readable access code (e.g. `RAVEN-4721`) are generated.
- The app opens in the browser at `http://localhost:8443` for the IC, with no certificate warning, and the Section panel shows the QR code, addresses, code, pre-flight check and who is connected.
- Keep the HQ window open while the exercise runs. Use **Pause session** to stop for the night and **End session** at the end of the exercise.

Options: `CBP-HQ.exe --team "CPT 2" --incident INC-261001-02 --code ALFA-2024 --port 9443 --no-browser`. `--help` lists all.

## Command rights

The IC laptop is always IC. The IC can make one member 2IC and one member Intel from the Section panel. Only the IC and 2IC can change the incident ID, declare, stand down, issue the warning order and orders, deliver the back brief, issue FRAGOs, change the phase, reclassify severity, edit the roster and assign tasks. The HQ enforces this: such entries from other devices are refused. Everyone can record findings, RFIs, RFCs, SITREPs and update the status of tasks.

## Pre-flight check (Windows)

At start and in the Section panel, the HQ checks: network set to Public, firewall rules blocking the HQ, no Wi-Fi or Ethernet connection. **Fix it** sets the network to Private, removes blocking rules and adds `CBP Field HQ` rules for TCP 8443 and UDP 5353, after one administrator prompt. On managed work laptops, IT policy may prevent the fix.

## Join

**IC:** the app opens automatically at `http://localhost:8443/`. Enter your name and callsign; the HQ laptop is always the IC, you join automatically and the Section panel opens.

**Analysts on a phone:** connect to the section network and scan the QR code.

**Analysts on a computer:** connect to the section network and type one of the addresses shown on the IC screen, for example `cpt1.local:8443` or `192.168.1.20:8443`. No need to type `https://`, the server redirects. The app opens a join box: enter the access code, your name and callsign, press Enter.

The `.local` name is announced on the local network (mDNS) and works on most Windows, macOS, Linux and iOS devices. If it does not resolve, use the IP address. Change the name with `--name alpha` (gives `alpha.local`).

**By link:** the IC console has *Copy join link* buttons. Send the link over your out of band channel (Signal, Teams); it opens the app and joins in one step. The link contains the access code, so treat it like the code.

Every device shows a certificate warning the first time: check the fingerprint matches the one on the IC screen before accepting.

The header shows the team status, for example `CPT 1 · 4` when connected, `Reconnecting` if the link drops. Click it to see who is on the net, enter a code manually, or leave.

## Several teams on one exercise network

Each team's IC runs its own HQ. Sessions are separate: each HQ has its own incident ID, access code and certificate, and a device can only join with that HQ's code.

Give every HQ its own team label (the local name follows it):

```
CBP-HQ.exe --team "CPT 1" --incident INC-261001-01
CBP-HQ.exe --team "CPT 2" --incident INC-261001-02
```

Analysts then type `cpt1.local:8443` or `cpt2.local:8443`, and the join box shows the team label so they can check they are on the right HQ before entering the code. If two HQs start with the same name, the second one switches to `name-2.local` automatically and says so in the terminal.

Good practice on a shared network:
- Brief each team on its own HQ address, code and certificate fingerprint.
- Never reuse an access code between teams.
- If the exercise network may carry a red team, prefer a separate Wi-Fi or VLAN per team. Content is encrypted by TLS, but a hostile device on the same network can still try to disrupt the HQ.
- Some exercise networks block multicast, so `.local` names may not resolve. Use the IP address shown in the terminal.

Only real Wi-Fi and Ethernet addresses are shown. Virtual adapters (VMware, Hyper-V, WSL, Docker, VPN) are hidden because other computers cannot reach them; `--all-interfaces` lists them anyway.

## What is shared

| From | To | Items |
|---|---|---|
| IC and 2IC | Section | Incident declaration and ID, severity, phase, roster, tasks, warning order, back brief, orders, FRAGOs, stand down (with acknowledge banners) |
| Section | IC and section | Log entries, findings with artifacts and ATT&CK techniques, host status changes, RFIs, RFCs, SITREPs, AAR proposals, task acknowledgements and status |
| HQ | White Cell | Team status, RFIs and RFCs addressed to WC, inject acknowledgements |
| White Cell | HQ | Injects, RFI answers, RFC decisions |

Drafts stay on each device until submitted.

A member who reloads the page or reopens the tab rejoins without the code: the device keeps the code, name and callsign for 72 hours, only for that HQ, and erases them when the member leaves, when the IC ends the session, or when the HQ refuses the code.

## If the IC laptop fails

If the same laptop comes back, start CBP-HQ and resume the saved session (see Pausing overnight).

If it is gone for good, every device still keeps a full copy. Start the HQ on any other laptop with the same incident ID and code:

```
CBP-HQ.exe --team "CPT 1" --incident INC-261001-07 --code ALFA-2024
```

Devices that reconnect push their copy and the new server is reseeded automatically. Devices loaded from the old laptop's address must reopen the app at the new address.

## Pausing overnight

Exercises often stop at the end of the day and pick up the next morning. The HQ keeps the session for you.

- **Pause session** in the Section panel gives everyone 30 seconds to submit what they are typing, saves the session and closes the HQ. Analysts see an orange bar saying the exercise is paused.
- Next morning, start `CBP-HQ.exe` again. It lists the saved sessions on this laptop: type the number and press Enter, then the passphrase if you set one. The team, incident ID, access code, log, findings, evidence, orders, tasks and 2IC/Intel designations all come back.
- Analysts do nothing. A page left open reconnects by itself within 30 seconds; a closed tab rejoins without the code when they open the same address (the device remembers it for 72 hours).
- The H clock keeps running through the night. The log records when the exercise was paused and when it resumed.
- **End session** is for the real end of the exercise: it closes the HQ and deletes the saved file.

The HQ also writes a checkpoint a few seconds after every change. If the laptop crashes, runs out of battery or the window is closed by mistake, start CBP-HQ again and pick the session: devices push back anything the last checkpoint missed.

**Passphrase.** When a new session starts, the HQ asks for an optional passphrase. With one, the saved file is encrypted (AES 256 GCM, key derived with scrypt) and the session cannot be resumed without it. Without one, the file is only compressed: fine for training on a closed network, not for anything sensitive. There is no way to recover a forgotten passphrase.

Saved sessions live in the `sessions` folder next to `CBP-HQ.exe`. Copy that folder with the exe if you move to another laptop. If the laptop gets a different IP address overnight, the HQ makes a new certificate and devices see the certificate warning once more: check the fingerprint again.

The White Cell works the same way: closing its window saves the console (teams, answers, injects). At the next start, pick the White Cell session from the list. Injects that were scheduled for a time that passed during the pause are **held** until the White Cell clicks **Send now** or **Cancel**. **End exercise** in the console deletes the White Cell file.

Options: `--resume latest` (or a file name) skips the list, `--passphrase TEXT` avoids the prompt, `--no-save` keeps everything in memory only, as before 1.9.

## Certificates

By default the server creates a self signed certificate for its current addresses (valid 30 days, stored in `certs/`, renewed automatically when the address changes). Browsers warn once per device; confirm the fingerprint before accepting.

For exercises, install a training CA on the devices and start with:

```
CBP-HQ.exe --cert training-hq.pem --key training-hq-key.pem
```

In production use a certificate from your organization's PKI.

iPhones may refuse live sync with a self signed certificate even after accepting the warning. Install a training certificate profile on iOS devices, or have iPhone users use *Send to IC*.

`--http` runs without TLS for quick tests on one machine. On other devices, file hashing, camera and clipboard may not work.

## Security notes

- Join requires the access code; the incident number is not a password. Ten failed attempts from one address block it for ten minutes.
- WebSocket connections from other web origins are refused.
- The IC console is only reachable from the IC laptop itself.
- The saved session holds everything the HQ holds, evidence included. Use a passphrase outside a closed training network, and delete the `sessions` folder (or use End session) when the exercise is over.
- Memory cap 512 MB; large evidence should be recorded as hash references.
- Firewall: allow inbound TCP on the chosen port, and UDP 5353 for the `.local` name, on the section network only.

## Host board and ATT&CK

Every machine named in *Affected machines* in a finding appears on the Host board as Compromised. Anyone on the net can set it to Isolated, Cleaned or Restored; each change is logged with name and time and syncs to the team. Hosts can be added by hand. The SITREP prefills a *Hosts* line from the board.

Findings can be linked to one or more of about 45 common MITRE ATT&CK techniques, grouped by tactic.

## White Cell (exercises)

The White Cell (WC) plays the higher HQ and everyone the teams do not have. It sees what a higher HQ would: each team's status, and the RFIs and RFCs they address to WC. It does not see findings, logs, SITREPs, orders or tasks.

**White Cell laptop**
1. Double click **CBP-HQ.exe** and type `WC` when it asks for the team.
2. Press Enter to generate an exercise code (or type one). Give this code to every IC.
3. The White Cell console opens in the browser. HQs started with the exercise code on the same network appear by themselves: the console looks them up by local name and also checks its own subnet on port 8443 every 45 seconds (**Scan network** runs it now). If an HQ uses another port, start with `--scan-ports 9443`, or add it by address.
4. From the console: answer RFIs, approve or reject RFCs (with a comment, or ask for more information), send injects to one team or all (now or at a set time), and follow response times. **Export log (CSV)** keeps a record for the hot wash.

**Each IC**
- When the HQ asks for the White Cell code, type the exercise code. Press Enter to run without a White Cell.
- An orange **WC · White Cell** badge appears in the header of every device while the White Cell is connected, and the IC's log records when it connects and disconnects.
- RFIs and RFCs have an **Addressed to** field: `WC` goes to the White Cell, `IC` stays in the team.
- Injects appear as a banner for the IC and 2IC with **Acknowledge**. The White Cell sees who acknowledged and how fast.
- When the WC answers an RFI or decides on an RFC, the author and the IC get a notification, and the answer or decision is added to the record.
