# Demo team and action routing

This is a fictional Acme API Tools team. Replace the routing details with your own
workspace values before approving a real action.

| Name | Role | Contact | Follow-up responsibility |
| --- | --- | --- | --- |
| Sam Rivera | GTM lead | sam@example.com | Owns outbound research and follow-up |
| Alex Morgan | Developer relations | alex@example.com | Reviews technical claims |

The intended Linear team key is the `linear_team_key` workspace variable
(initially `GTM`). Resolve it against the connected user's own Linear workspace.
Use that exact team, and omit assignee unless a real user matching the intended
owner can be verified. If the team cannot be found, fail planning with an
actionable note; never select an arbitrary team.

All three Gmail drafts must be addressed only to the `demo_recipient` workspace
variable, after the user replaces `you@example.com` with their own connected Gmail
address. The fictional contacts above and real prospects are never recipients.
Never send or schedule email. A reviewed plan and explicit approval are required
before creating any Gmail draft or Linear issue.
