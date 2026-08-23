# Screen App

Public venue display for live boards, next matches, results and tournament highlights.

## Current Blindleia Live v1

`index.html` is a dependency-free venue screen designed for a TV/browser in the club.
It polls the local API at `../api/live.php` every three seconds. The screen never calls DartsAtlas directly.

The live API returns:

- active matches by board
- current legs and remaining score when available
- player averages / first nine when available
- 180 counts and highest checkouts
- next matches
- recently completed results
- a simple current-tournament form table
- DartsAtlas feed freshness

The screen also detects increases in the tournament 180 count and shows a full-screen 180 animation. A new highest checkout can trigger a similar overlay.

Open a specific local tournament with:

```text
/screen/?tournament_id=123
```

Without a tournament ID, the API automatically selects the most recently active/relevant tournament.

## Data flow

```text
DartsAtlas
   |
   | DartsAtlas worker (~8 s during active tournament)
   v
Blindleia DB
   |
   | apps/api/live.php
   v
Screen browser (~3 s local polling)
```

This keeps provider traffic independent of the number of TVs or browsers connected to Blindleia Live.

## Graceful degradation

DartsAtlas does not always expose the same detail level for every match. The screen is therefore designed to work at several levels:

1. player names + result only
2. live legs / board
3. remaining score
4. averages / first nine
5. 180 and checkout statistics

Missing provider fields are shown as `–` rather than inferred.

## Next capabilities

- club/sponsor media rotation
- ELO and season standings views
- event ticker / records
- player profile cards from the member/player link
- Scolia phase 2 for richer visit/dart-level events
