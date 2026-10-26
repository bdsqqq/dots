# footage banks are discovery sources, not blanket permission

## where to start

| source | useful for | inspect before reuse |
|---|---|---|
| [Wikimedia Commons video search](https://commons.wikimedia.org/w/index.php?search=parkour&title=Special:MediaSearch&type=video) | CC/public-domain footage across activities and subjects | individual file page: original creator, source, license/version, attribution, derivative requirements and other rights. not every item uses the same license. |
| creator-owned gameplay collections with an explicit reuse license | genuine parkour with the right camera, duration and format | individual upload's permission statement; creator's relationship to the recording; game/asset/music rights; original upload rather than an uncredited mirror. |
| [Openverse](https://openverse.org/about) | discovering external sources and related openly licensed assets | Openverse currently indexes images/audio, with video through external sources. do not invent a native video search API or treat its metadata as rights clearance. |

**previously workable example, not a permanent whitelist:** GameplaysForFree's [Minecraft parkour video 100](https://www.youtube.com/watch?v=BuRJi_2TE6w), [creator channel](https://www.youtube.com/channel/UCyjMmPUSDB8yzb4GutNbasw). its description inspected on 2026-10-23 explicitly declared CC BY 4.0, allowed downloads/screen recording and Reddit stories/voiceovers, required creator credit, and asked not to reupload it as generic free gameplay. the obtained source was native 1080×1920/60fps. it has conspicuous shader bloom: favor a less blown-out clip for a new production. recheck the actual upload/terms and downloadability each time; do not extend one upload's statement to an entire channel.

the creator's requested credit, with the source filled in:

```text
Video by GameplaysForFree, licensed under CC BY 4.0:
https://creativecommons.org/licenses/by/4.0/
Original video: https://www.youtube.com/watch?v=BuRJi_2TE6w
Adapted: trimmed, resized, and combined with original narration and captions.
```

“free,” “royalty-free” and “Creative Commons” are different claims. custom stock-site licenses are not CC; use them only when the brief permits their actual terms. do not use unlicensed compilations merely because a downloader works.

## per-item decision

- **CC0 / public domain:** retain the declaration and provenance; check whether the status applies to this work/jurisdiction and whether other rights remain.
- **CC BY:** retain creator/title/source/license information, required notices and change attribution. CC BY 4.0 permits adaptations and commercial reuse subject to its terms, but does not clear every other right.
- **CC BY-SA:** assess the adaptation's share-alike obligations against the intended deliverable. do not casually promise a private/proprietary derivative can be redistributed without constraints. use a simpler compatible source if this is unresolved.
- **NC / ND:** do not assume private business work is noncommercial or that a captioned/cropped narrated adaptation meets ND restrictions. choose another suitable source unless the intended use is clearly authorized.
- **unclear uploader authority or conflicting permissions:** look for the original or another clip. never invent clearance, seek approval by contacting someone, or publish as part of sourcing without authorization.

for gameplay, inspect the publisher's usage policy as well as the recording license. [Minecraft's guidelines](https://www.minecraft.net/en-us/usage-guidelines) retain Mojang/Microsoft rights and restrict endorsement and unrelated corporate promotion. a creator's CC statement cannot grant those underlying rights. do not treat an internal editorial cut as blanket permission for public marketing. retain required disclaimers where applicable and make unresolved distribution rights explicit.

## provenance that travels with the output

save a small `media/provenance.json` and permission evidence beside the renderer:

```json
{
  "creator": "original recording creator",
  "title": "exact source title",
  "source_url": "original item page",
  "retrieved_date": "YYYY-MM-DD",
  "license": "exact name and version or public-domain basis",
  "license_url": "actual applicable terms",
  "permission_evidence": "saved description or item-page excerpt",
  "required_credit": "complete source-specific credit",
  "source_segment_seconds": [10, 165],
  "local_file": "media/background.mp4",
  "sha256": "hash of the actual downloaded file",
  "changes": "actual trim/crop/resize/grade/overlays/audio changes",
  "other_rights_or_limits": "underlying assets, music, people, distribution limits"
}
```

these are fields to fill with evidence, not text to copy as asserted facts. record measured dimensions, frame rate and duration too. retain permission text without exporting raw downloader metadata containing expiring URLs, local paths or network identifiers. give the final video an accompanying credit that survives transfer; for standalone circulation, add an appropriate credit in the video or its actual destination description rather than relying on an absent README.

download the approved clip with a public direct-media request or installed yt-dlp. when using yt-dlp, parameterize the original URL, desired format and segment; preserve a reusable command/script. no credentials, browser cookies or bypass flags. a downloader is transport, not a licensing check. failed access means another legitimate source, not an unauthorized mirror.

## authoritative references

- [Commons reuse guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia): per-file requirements, creator attribution, no licensing warranty and other rights.
- [CC BY 4.0 deed and legal-code link](https://creativecommons.org/licenses/by/4.0/): credit, license link, changes, no endorsement, no warranties.
- [Openverse's scope and license-verification limits](https://openverse.org/about).
- [Minecraft usage guidelines](https://www.minecraft.net/en-us/usage-guidelines): inspect current terms for the actual use, not a remembered summary.
