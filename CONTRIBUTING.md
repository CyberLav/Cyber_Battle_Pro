# Contributing to Cyber Battle Pro

Thanks for wanting to help. Cyber Battle Pro started as a tool for one cyber section and grows with the people who use it in exercises.

## Bugs and ideas

Open an issue. Say what you did, what you expected and what happened, with the version shown at the bottom right of the app. Screenshots help.

Please never paste real incident data, classified or protected information, real hostnames, IP addresses or accounts from an operational network. Use made up exercise data.

Ideas are welcome. By posting an idea or suggestion you agree that it can be used in any version of the project, as section 6 of the [CLA](CLA.md) explains.

## Code and documentation

1. Fork the repository and create a branch for your change.
2. Keep the change focused: one fix or one feature per pull request.
3. Test it: `npm ci`, then `npm start` for the team HQ, and open `public/index.html` on its own for the solo mode.
4. Open a pull request that explains what changes for the IC or the analyst.
5. On your first pull request, the CLA bot asks you to sign the [Contributor License Agreement](CLA.md) by posting one sentence as a comment. You sign once; it covers all your later contributions.

### Why a CLA?

Cyber Battle Pro is open source under the [GNU AGPL v3](LICENSE). The author also wants to be able to offer it under other terms, for example to an organization that cannot use the AGPL. The CLA lets him do that with code from contributors. You keep the copyright in your work, and everything accepted stays available in the open source version.

### Work done on duty

If you write code as part of your job, in the Canadian Armed Forces, the public service or a company, your employer or the Crown may own it. Only contribute work you did on your own time and equipment, or work you have written permission to share.

## Style

- Everything in the interface is in English, with plain military wording where the doctrine uses it.
- Times are Zulu, with local time next to them where people act on them.
- The app stays one HTML file that works offline. No new runtime dependencies without discussing it first in an issue.
- Keep the credit in the footer as it is. The [NOTICE](NOTICE) file explains why.
