# Data Flow

## Hosted runtime

```text
Browser over HTTPS
  -> Node.js web launcher
  -> React static assets + Express API + private simulation sidecar
  -> encrypted PII vault / operational evidence stores
```

The browser has no Node or filesystem access. The launcher owns backend and
sidecar lifecycle. The hosting platform provides TLS, an application port, and
a persistent directory for encrypted configuration and student data.

## Student authentication

Email and password are submitted to the local backend. Password and recovery
code become salted hashes. The email is encrypted in the PII vault and indexed
by a non-plaintext hash. Session tokens are random, stored hashed server-side,
and revocable per session or per student.

Every student resource derives identity from the authenticated session. Route
IDs are rejected when they do not match that identity.

## Administrator secrets

The administrator authenticates with an HttpOnly session and CSRF token.
Bootstrap/recovery and secret changes use authenticated, CSRF-protected,
same-origin routes. The backend validates provider keys against fixed endpoints,
encrypts them with the platform wrapping key, and reloads the service. No
response contains a secret value.

## Advice request

1. Screen input in memory for crisis, ghostwriting, credentials, and sensitive
   data.
2. Classify the topic and run deterministic FAFSA/deadline rules when
   applicable.
3. Retrieve relevant, current evidence.
4. For AI coaching, redact provider payloads and reserve worst-case cost.
5. Send only to `https://openrouter.ai/api/v1`.
6. Screen the output, reconcile cost, and compose claim-level lanes.
7. Encrypt chat/advice history before persistence.

Regulated requests without verified evidence return a limitation and official
source action instead of a model guess.

## External services

| Destination | Data | Gate |
| --- | --- | --- |
| OpenRouter | redacted coaching prompt | authenticated student, explicit consent, budget reservation |
| api.data.gov | college identifier/query | configured IPEDS key |
| allowlisted official education source | public source refresh | deterministic scheduled ingestion |

There is no general runtime web search, arbitrary URL, student BYOK, parent email
notification, or student-accessible counselor configuration flow.

## Export and deletion

Export includes profile, consents, chats, advice claims and sources, deadlines,
Council output, usage, narratives, and attachments.

Deletion revokes sessions and removes credentials, encrypted PII, operational
rows, evidence/vectors owned by the student, attachments, caches, and exports.
Success is returned only after all deletion steps complete.
