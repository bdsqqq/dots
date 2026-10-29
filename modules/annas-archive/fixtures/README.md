# search fixtures

`search.html` and `empty.html` are reduced responses from authenticated
`https://annas-archive.gl/search`, acquired 2026-10-27. queries are in their
page titles. result lists retain the first three cards; scripts, images,
event handlers, account navigation and cookies are excluded. exact account
key and session-cookie values were checked absent before writing.

`empty.html` matters because anna renders 50 partial matches even when its
primary search says “No files found.” those are not primary query results.
`search.html` retains next-page navigation; neither fixture proves totals or
complete coverage. fixture reduction uses a DOM parser, not script execution.
