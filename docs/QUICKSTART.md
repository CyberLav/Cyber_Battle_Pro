# Quick start

## IC

1. Connect the laptop to the section network.
2. Double click **CBP-HQ.exe**.
   - The black window asks for the team for this session. Type it (e.g. `CPT 1`) and press Enter. Nothing else starts until you do. It is asked at every start.
   - It then asks for the White Cell exercise code. Type it if there is a White Cell, otherwise press Enter.
   - If Windows SmartScreen appears: *More info*, then *Run anyway*.
   - If Windows asks about network access: *Allow*.
3. The app opens in your browser. If it does not, open **http://localhost:8443** yourself. Enter your name and callsign (the HQ laptop is always the IC).
4. The **Section** panel opens: QR code, address, access code, who is on the net.
   - If it says *Analysts may not be able to connect*, click **Fix it** and approve the administrator prompt.
5. Optional: in the Section panel, click **Make 2IC** or **Make Intel** next to a member. Only the IC laptop and the 2IC can issue orders, deliver the back brief, declare, change the incident ID or phase, or reclassify severity. The Section list on the Declare page fills in automatically as people join.
6. Brief the section: show the panel (or *Projector view*), or click an address to copy a join link for Signal or Teams.
7. Run the incident.
8. At the end: export the PowerPoint, then **End session** in the Section panel. Everyone gets 60 seconds to send or export, then the HQ closes and its memory is cleared.

Keep the black HQ window open during the session. Closing it ends the session.

## Analyst

- **Phone:** scan the QR code.
- **Computer:** type the address shown by the IC, e.g. `cpt1.local:8443` (or the IP).
- Accept the certificate warning after checking the first characters match the IC's screen.
- Check the team label, enter the access code (e.g. `RAVEN-4721`), your name and callsign.
- Record findings in the Findings journal and link MITRE ATT&CK techniques; entries collapse to one line, click to expand.
- Acknowledge new tasks from the red banner, and update host status on the Host board.
- If the page reloads, you rejoin by yourself without the code.
- When the red bar says the HQ is closing, use **Send to IC** or export what you need.

## Several teams on one network

Each IC runs CBP-HQ with its own team label. Addresses become `cpt1.local`, `cpt2.local` and so on, each with its own code. If two HQs pick the same name, the second becomes `name-2.local` automatically.

## Orders to PDF

Warning order, back brief and orders each have **Download PDF**: a formatted order document with numbered paragraphs, ready to print or send.

## After action review

The IC and 2IC write the AAR. Members can only fill in Sustain and Improve and submit them as proposals; the IC sees who proposed what in the list at the bottom of the page.

## Findings journal to PDF

On the Findings journal step, **Download journal (PDF)** produces one PDF with every finding, screenshots embedded at full resolution, and all attached files embedded at full size (see the attachments panel of your PDF reader).

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
