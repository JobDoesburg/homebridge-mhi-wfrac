# Tests

Run with `npm test` (lints, builds, then runs `node --test`).

`vectors.json` holds decode and encode vectors generated with [pywfrac](https://github.com/blues-sechseck/pywfrac),
the protocol library behind the Home Assistant integration, so the encoder here is checked byte for byte against
an implementation that is known to work on real units. The two decode captures are real device responses
(from issue #43 and PR #44).
