"""Irish registration plate index marks (since 2014) for County Collector.

Rarity tiers loosely follow county population: more cars = easier to spot.
keywords include common speech-recognition mishearings ("Laois" is often heard as "leash").
"""

TIER_POINTS = {1: 1, 2: 2, 3: 3, 4: 5}

# code, county, province, tier, extra spoken keywords
COUNTIES = [
    ("D", "Dublin", "Leinster", 1, ["dublin"]),
    ("C", "Cork", "Munster", 1, ["cork", "rebel county"]),
    ("G", "Galway", "Connacht", 1, ["galway"]),
    ("KE", "Kildare", "Leinster", 1, ["kildare", "kill dare"]),
    ("MH", "Meath", "Leinster", 1, ["meath", "meeth"]),
    ("L", "Limerick", "Munster", 1, ["limerick"]),
    ("DL", "Donegal", "Ulster", 2, ["donegal", "donnie gal", "donny gal"]),
    ("T", "Tipperary", "Munster", 2, ["tipperary", "tipp", "tip"]),
    ("WX", "Wexford", "Leinster", 2, ["wexford"]),
    ("KY", "Kerry", "Munster", 2, ["kerry", "carry"]),
    ("WW", "Wicklow", "Leinster", 2, ["wicklow", "wick low"]),
    ("MO", "Mayo", "Connacht", 2, ["mayo", "may oh"]),
    ("LH", "Louth", "Leinster", 2, ["louth", "lowth"]),
    ("W", "Waterford", "Munster", 2, ["waterford", "water ford"]),
    ("CE", "Clare", "Munster", 2, ["clare", "claire"]),
    ("KK", "Kilkenny", "Leinster", 3, ["kilkenny", "kill kenny"]),
    ("WH", "Westmeath", "Leinster", 3, ["westmeath", "west meath"]),
    ("LS", "Laois", "Leinster", 3, ["laois", "leash", "leesh", "lease"]),
    ("OY", "Offaly", "Leinster", 3, ["offaly", "awfully", "offally"]),
    ("CN", "Cavan", "Ulster", 3, ["cavan", "cabin", "caven"]),
    ("SO", "Sligo", "Connacht", 3, ["sligo", "sly go"]),
    ("RN", "Roscommon", "Connacht", 3, ["roscommon", "ross common"]),
    ("MN", "Monaghan", "Ulster", 3, ["monaghan", "monahan", "mona han"]),
    ("CW", "Carlow", "Leinster", 4, ["carlow", "car low"]),
    ("LD", "Longford", "Leinster", 4, ["longford", "long ford"]),
    ("LM", "Leitrim", "Connacht", 4, ["leitrim", "lee trim", "lea trim"]),
]

ALL = {c[0]: {"code": c[0], "name": c[1], "province": c[2], "tier": c[3], "points": TIER_POINTS[c[3]], "keywords": c[4],
              "bonus": False} for c in COUNTIES}
COUNTY_CODES = [c[0] for c in COUNTIES]
