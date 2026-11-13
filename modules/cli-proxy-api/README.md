# inference brokering

requests move to the credential owner; OAuth grants do not. independent enrollment
keeps rotating grants and refresh ownership local. separate logins to the same
provider account do not create more quota. client and peer keys permit execution
without distributing provider grants or management access.

## why peering is opt-in

local gateways keep another machine from becoming a prerequisite for inference.
[peering](peering.ts) is separate from ordinary broker connections because it
changes the execution owner and supports HTTP/SSE, not WebSockets.

receiving peers execute locally so cyclic membership cannot create forwarding
loops. discovery may try another owner, but an attempted inference POST is never
replayed: a broken connection does not prove the provider rejected the request.
retrying could duplicate inference.

quota display is not scheduling. T3's native usage-source integration reports
limits without changing routes; successful model discovery proves neither quota
visibility nor provider execution.

## why bodies stay in native history

wire capture repeatedly stored growing conversation prefixes already retained
incrementally by native harnesses. the [archive is retired](../inference-archive/README.md);
existing recordings and backups remain, not an active retention guarantee.

`request-log=false` still records failed bodies upstream. [gateway initialization](broker.ts)
therefore enables `server.commercial-mode` to omit that middleware entirely.
