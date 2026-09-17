# Retention policy (draft)

> DRAFT. Version `2026-09-draft-1`. The executable form is
> `apps/flats/src/privacy/retention-policy.js`; this page mirrors it for review.
> Nothing is deleted until `PRIVACY_RETENTION_POLICY_APPROVED=2026-09-draft-1`
> is set, and any edit to the policy requires approving the new version.
> Periods are proposals, not legal advice.

| Data class | Period | Action | Enforced by | Justification |
|---|---|---|---|---|
| Live listings | While live at source | Retain with justification | Existing listing lifecycle | The purpose lasts as long as the advertisement |
| Historical listing snapshots | 12 months | Delete | `retention:run` | Repost detection looks back months; aggregates stay in property clusters |
| Availability observations | 12 months | Delete | `retention:run` | Derived evidence is kept on the actor |
| Identity alias history | 12 months | Delete | `retention:run` | Churn detection uses at most 12 months |
| Contact points not seen | 18 months | Delete | `retention:run` | No longer advertising anything |
| Dismissed risk evidence | 6 months | Delete | `retention:run` | Briefly kept to recognise an already-reviewed pattern |
| Open / watched / resolved risk evidence | 18 months not re-observed | Delete | `retention:run` | No longer describes current behaviour |
| Confirmed risk evidence | 36 months not re-observed | Retain with justification, then delete | `retention:run` | Protects later users from a returning actor — **legal review** |
| Trust evidence | 18 months | Delete | `retention:run` | Not kept longer than the risk it balances |
| Review audit events | 36 months | Retain with justification, then delete | `retention:run` | Accountability (Art 5(2)) — **legal review** |
| Closed privacy requests | 36 months after closure | Delete | `retention:run` | Evidence of handling for complaints — **legal review** |
| Closed disputes | 36 months after closure | Delete | `retention:run` | As above |
| Source scan runs | 6 months | Delete | `retention:run` | Operational metrics, no personal data |
| Legacy registry rows | 18 months uncorroborated | Delete | **Not implemented** | Legacy labels without new evidence expire |
| Telegram subscribers | On unsubscribe; 12 months inactive | Delete | **Not implemented** (subscription-bot) | Contract ended |
| Candidate profiles | 6 months after inactive at source | Delete | **Not implemented** (workforce) | Candidate no longer publishing |
| Technical logs | 30 days | Delete | **Not configured** (deployment log rotation) | Debugging only |

Evidence and contacts under an open dispute are never deleted by retention
until the dispute is decided. Aggregation and anonymisation are listed as
actions in the policy model but no class currently uses them.
