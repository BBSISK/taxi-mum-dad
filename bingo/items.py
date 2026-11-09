"""Car Bingo item catalogue: things you can spot from an Irish car window.

tier 1 = everyday (1 pt), 2 = fairly common (2), 3 = lucky (3), 4 = rare (5).
keywords are what players might say; matching is done on the phone (bingo.js).
"""

TIER_POINTS = {1: 1, 2: 2, 3: 3, 4: 5}

ITEMS = [
    # tier 1: everyday
    ("red_car", "Red car", "🚗", 1, ["red car"]),
    ("white_van", "White van", "🚐", 1, ["white van"]),
    ("dog", "Dog", "🐕", 1, ["dog", "doggy", "puppy"]),
    ("bus_stop", "Bus stop", "🚏", 1, ["bus stop"]),
    ("traffic_lights", "Traffic lights", "🚦", 1, ["traffic light", "traffic lights"]),
    ("roundabout", "Roundabout", "🔄", 1, ["roundabout"]),
    ("bicycle", "Bicycle", "🚲", 1, ["bike", "bicycle", "cyclist"]),
    ("cow", "Cow", "🐄", 1, ["cow", "cows"]),
    ("petrol_station", "Petrol station", "⛽", 1, ["petrol station", "garage", "filling station"]),
    ("post_box", "Green post box", "📮", 1, ["post box", "postbox", "letter box"]),
    ("school", "School", "🏫", 1, ["school"]),
    ("motorbike", "Motorbike", "🏍️", 1, ["motorbike", "motorcycle"]),
    ("crow", "Crow or magpie", "🐦‍⬛", 1, ["crow", "magpie"]),
    ("taxi", "Taxi", "🚖", 1, ["taxi"]),
    # tier 2: fairly common
    ("tractor", "Tractor", "🚜", 2, ["tractor"]),
    ("horse", "Horse", "🐎", 2, ["horse", "pony"]),
    ("church", "Church", "⛪", 2, ["church", "chapel"]),
    ("sheep", "Sheep", "🐑", 2, ["sheep", "lamb"]),
    ("yellow_car", "Yellow car", "🟡", 2, ["yellow car"]),
    ("bridge", "Bridge", "🌉", 2, ["bridge"]),
    ("lorry", "Big lorry", "🚛", 2, ["lorry", "truck", "articulated"]),
    ("playground", "Playground", "🛝", 2, ["playground", "swings", "slide"]),
    ("gaa_pitch", "GAA pitch", "🏐", 2, ["gaa", "goal posts", "goalposts", "pitch", "hurling", "football pitch"]),
    ("red_door", "Red front door", "🚪", 2, ["red door"]),
    ("flag", "Irish flag", "🇮🇪", 2, ["flag", "tricolour", "tricolor"]),
    ("digger", "Digger", "🏗️", 2, ["digger", "excavator", "jcb"]),
    ("speed_camera", "Speed camera van", "📸", 2, ["speed camera", "speed van", "go safe"]),
    ("blue_car", "Blue car", "🔵", 2, ["blue car"]),
    # tier 3: lucky
    ("double_decker", "Double-decker bus", "🚌", 3, ["double decker", "double-decker", "doubledecker"]),
    ("garda_car", "Garda car", "🚓", 3, ["garda", "guards", "police", "squad car", "cop car"]),
    ("ambulance", "Ambulance", "🚑", 3, ["ambulance"]),
    ("fire_engine", "Fire engine", "🚒", 3, ["fire engine", "fire truck", "fire brigade"]),
    ("caravan", "Caravan", "🏕️", 3, ["caravan", "camper", "motorhome", "camper van"]),
    ("cement_mixer", "Cement mixer", "🌀", 3, ["cement mixer", "concrete mixer", "mixer truck"]),
    ("wind_turbine", "Wind turbine", "🌬️", 3, ["wind turbine", "windmill", "turbine"]),
    ("thatched_cottage", "Thatched cottage", "🏡", 3, ["thatched", "thatch", "cottage"]),
    ("castle", "Castle", "🏰", 3, ["castle", "tower house"]),
    ("donkey", "Donkey", "🫏", 3, ["donkey"]),
    ("l_plate", "L or N plate", "🔰", 3, ["l plate", "learner", "n plate", "novice"]),
    ("purple_car", "Purple car", "🟣", 3, ["purple car"]),
    ("pink_car", "Pink car", "🩷", 3, ["pink car"]),
    ("tow_truck", "Tow truck", "🛻", 3, ["tow truck", "recovery truck", "breakdown truck"]),
    ("goat", "Goat", "🐐", 3, ["goat"]),
    # tier 4: rare
    ("round_tower", "Round tower", "🗼", 4, ["round tower"]),
    ("horse_box", "Horse box", "🐴", 4, ["horse box", "horsebox"]),
    ("vintage_car", "Vintage car", "🏎️", 4, ["vintage car", "old car", "classic car"]),
    ("ice_cream_van", "Ice-cream van", "🍦", 4, ["ice cream van", "ice-cream van", "ice cream"]),
    ("convertible", "Convertible, roof down", "😎", 4, ["convertible", "roof down"]),
    ("hearse", "Hearse", "⚱️", 4, ["hearse"]),
    ("someone_on_horse", "Someone riding a horse", "🏇", 4, ["riding a horse", "horse rider", "on a horse"]),
    ("helicopter", "Helicopter", "🚁", 4, ["helicopter", "chopper"]),
    ("tractor_trailer_hay", "Tractor with hay bales", "🌾", 4, ["hay", "bales", "silage"]),
    ("swan", "Swan", "🦢", 4, ["swan"]),
    ("deer", "Deer", "🦌", 4, ["deer"]),
    ("rainbow", "Rainbow", "🌈", 4, ["rainbow"]),
    ("hot_air_balloon", "Hot-air balloon", "🎈", 4, ["balloon", "hot air"]),
]

BY_ID = {i[0]: {"id": i[0], "label": i[1], "emoji": i[2], "tier": i[3], "points": TIER_POINTS[i[3]], "keywords": i[4]}
         for i in ITEMS}
