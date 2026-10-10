# Codex fast mode

`/fast on` requests `service_tier: "priority"` for the selected OpenAI Codex coding model. `/fast off` stops overriding requests; `/fast status` reports the setting. Bare `/fast` toggles it.

Starts off. The setting follows the active session branch. Other providers and requests for other models are unchanged. Works in terminal and headless sessions.

Priority availability, quota/cost and latency depend on the account and service. Faster responses are not guaranteed.
