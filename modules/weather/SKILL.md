---
name: weather
description: "Get current weather or a short forecast for a specified location using curl and wttr.in. Use for weather questions; not place/business search, historical climate research, severe-weather alerts, or safety-critical forecasts."
---

# weather

use existing curl/jq; no additional CLI, account, key, or native settings file.
resolve the location and requested units/date first. send only the location needed
for the query, not a street address or unrelated personal data. use HTTPS, bounded
timeouts, and explicit location rather than automatic IP geolocation.

```sh
location='Sao+Paulo' # already URL-encoded location path
curl --fail --silent --show-error --max-time 20 --get \
  --data-urlencode 'format=j1' "https://wttr.in/$location" |
  jq -e 'if (.current_condition | type) == "array" and
    (.current_condition | length) > 0 and (.weather | type) == "array"
    then {location: .nearest_area, current: .current_condition, forecast: .weather}
    else error("invalid weather response") end'
```

for unusual characters, URL-encode the location path before fetching; do not
interpolate untrusted shell syntax. inspect the JSON shape before interpreting it:
`current_condition` must be a nonempty array and `weather` an array. an HTTP success
or nonempty HTML response is not weather evidence. stop on service errors or
malformed data; do not invent a forecast. choose the requested day from returned
forecast dates; wttr.in provides a short forecast, not arbitrary future dates.

report resolved location, observation/forecast date, units, and provider. distinguish
current observations from daily/hourly predictions. surface stale timestamps and
missing fields. for storm alerts, emergency decisions, or historical data use an
appropriate official meteorological source instead of this convenience service.

source: [wttr.in location, format, and JSON usage](https://github.com/chubin/wttr.in).
