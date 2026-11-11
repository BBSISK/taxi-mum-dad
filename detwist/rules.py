"""DeTwist rules, the same logic as static/detwist.js, so the server can replay a game move by move.

The board is a circle of P pins. Each band joins two pins. Two bands cross when exactly one end of
one of them lies between the ends of the other. On woven days every pair also has a fixed
over/under relation, `rel[i][j]` true meaning band i lies over band j.

A band is free (it pops and gives its pins back) when
- it crosses nothing, or
- on woven days, it lies over every band it crosses.
Freeing one band can free the next, so freed bands are removed repeatedly until none are left.
"""

MAX_MOVES = 300


def circ(a, b, pins):
    d = abs(a - b)
    return min(d, pins - d)


def _between(x, a, b):
    lo, hi = (a, b) if a < b else (b, a)
    return lo < x < hi


def crosses(p, q):
    return _between(q["a"], p["a"], p["b"]) != _between(q["b"], p["a"], p["b"])


def decode_rel(n, bits):
    """'1' at pair (i, j), i < j, in row order means band i is over band j. None on flat days."""
    if not bits:
        return None
    if len(bits) != n * (n - 1) // 2 or set(bits) - {"0", "1"}:
        raise ValueError("bad over/under data")
    rel = [[False] * n for _ in range(n)]
    k = 0
    for i in range(n):
        for j in range(i + 1, n):
            over = bits[k] == "1"
            k += 1
            rel[i][j] = over
            rel[j][i] = not over
    return rel


def free_ids(bands, rel):
    """Ids of the bands that are free right now."""
    crossing = {b["id"]: 0 for b in bands}
    over = {b["id"]: 0 for b in bands}
    for i, p in enumerate(bands):
        for q in bands[i + 1:]:
            if not crosses(p, q):
                continue
            crossing[p["id"]] += 1
            crossing[q["id"]] += 1
            if rel:
                top = p if rel[p["id"]][q["id"]] else q
                over[top["id"]] += 1
    return {b["id"] for b in bands if crossing[b["id"]] == 0 or (rel and over[b["id"]] == crossing[b["id"]])}


def settle(bands, rel):
    """Remove free bands, wave after wave, until none are free."""
    while bands:
        free = free_ids(bands, rel)
        if not free:
            break
        bands = [b for b in bands if b["id"] not in free]
    return bands


def replay(board, moves):
    """Play `moves` on `board`. Returns (ok, error). ok means every band was cleared by the last move.

    Each move is {"id": band, "end": "a" or "b", "to": pin}. A move is legal when the target pin is
    empty and no further than `step` pins round the rim from where that end is now (step 0 = anywhere).
    """
    pins, step, n = board["P"], board.get("step") or 0, board["n"]
    try:
        rel = decode_rel(n, board.get("rel"))
    except ValueError as e:
        return False, str(e)
    bands = [{"id": i, "a": a, "b": b} for i, (a, b) in enumerate(board["pins"])]
    if not isinstance(moves, list) or not moves or len(moves) > MAX_MOVES:
        return False, "no moves"
    for m in moves:
        if not bands:
            return False, "moves after the board was clear"
        if not isinstance(m, dict) or m.get("end") not in ("a", "b"):
            return False, "bad move"
        bid, to = m.get("id"), m.get("to")
        if type(bid) is not int or type(to) is not int:
            return False, "bad move"
        band = next((b for b in bands if b["id"] == bid), None)
        if band is None:
            return False, "that band is already free"
        if not 0 <= to < pins:
            return False, "no such pin"
        if any(to in (b["a"], b["b"]) for b in bands):
            return False, "that pin is taken"
        if step and circ(band[m["end"]], to, pins) > step:
            return False, "too far"
        band[m["end"]] = to
        bands = settle(bands, rel)
    if bands:
        return False, "board not cleared"
    return True, ""


def stars_for(moves, par, hints):
    """Three stars for par or better, two within 30% (at least 2 extra moves) of it, else one. A hint caps it at two."""
    slack = max(2, int(par * 0.3 + 0.5))
    stars = 3 if moves <= par else 2 if moves <= par + slack else 1
    return min(stars, 2) if hints else stars
