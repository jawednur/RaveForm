//Start HTTP Server & set PORT
var bodyParser = require('body-parser')
var cookieParser = require('cookie-parser');
var express = require('express');
var app = express();
var http = require('http').Server(app);
app.use("/assets", express.static(__dirname + '/assets'));
app.use(bodyParser.json());
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
var nodeHueApi = require("node-hue-api");
var discovery = nodeHueApi.discovery;
var v3 = nodeHueApi.v3;
var hueApi = v3.api;

//Initialize hue variables
var hostname = "";
var username = "";
var api;

http.listen(PORT, function () {
    console.log("Server listening on: http://localhost:%s", PORT);
});

//set Hostname
discovery.nupnpSearch()
    .then(function (searchResults) {
        if (searchResults.length === 0) {
            console.log('No bridges found');
            return;
        }
        const host = searchResults[0].ipaddress;
        hostname = host;
        console.log('Bridge found at:', hostname);
    })
    .catch(function (err) {
        console.error('Error searching for bridges:', err);
    });

//to save light group IDs
var highs;
var lows;
//initialize api
function init() {
    if (!hostname || !username) {
        console.log('Bridge hostname or username not set');
        return;
    }

    console.log('Initializing API with hostname:', hostname);

    // Create a new API instance with v3 API
    hueApi.createLocal(hostname).connect(username.replace(/['"]+/g, ''))
        .then(function (authenticatedApi) {
            api = authenticatedApi;
            console.log('API connected successfully');

            // Get groups using v3 API
            return api.groups.getAll();
        })
        .then(function (allGroups) {
            console.log('Found', allGroups.length, 'groups');

            var highsFound = false;
            var lowsFound = false;

            for (var i = 0; i < allGroups.length; i++) {
                console.log('Group', i, ':', allGroups[i].name, 'with lights:', allGroups[i].lights);

                if (allGroups[i].name == "highs") {
                    highs = allGroups[i].lights;
                    highsFound = true;
                    console.log('Found "highs" group with lights:', highs);
                }
                if (allGroups[i].name == "lows") {
                    lows = allGroups[i].lights;
                    lowsFound = true;
                    console.log('Found "lows" group with lights:', lows);
                }
            }

            if (!highsFound) {
                console.warn('Warning: "highs" group not found');
            }
            if (!lowsFound) {
                console.warn('Warning: "lows" group not found');
            }
        })
        .catch(function (err) {
            console.error('Error initializing API:', err);

            // If we get a 404 error, the username might be invalid
            if (err.message && err.message.includes('404')) {
                console.error('Authentication failed - username might be invalid');
                console.log('Please visit /reset to re-authenticate');
            }
        });
}

//set username and initialize
var setUser = function (result) {
    username = JSON.stringify(result);
    init();
};

var displayError = function (err) {
    console.log(err);
};

//sets hub username cookie if it wasn't previously set & redirects
app.get('/set', function (req, res) {
    if (!hostname) {
        console.error('No bridge hostname available');
        res.status(503).json({ error: 'Bridge not found. Please wait and try again.' });
        return;
    }

    if (username == "") {
        console.log('Creating new user on bridge at:', hostname);
        // Create unauthenticated api instance
        hueApi.createLocal(hostname).connect()
            .then(function (unauthenticatedApi) {
                // The user must press the button on the bridge before this call
                return unauthenticatedApi.users.createUser('RaveForm', 'RaveForm Device');
            })
            .then(function (result) {
                console.log('User created successfully:', result);
                username = result.username;
                init();
                res.cookie('Huesername', username, { maxAge: new Date(253402300000000) });
                res.sendStatus(200);
            })
            .catch(function (err) {
                console.error('Failed to create user:', err);
                if (err.message && err.message.includes('link button not pressed')) {
                    res.status(403).json({ error: 'Please press the button on your Hue bridge first' });
                } else {
                    res.status(500).json({ error: 'Failed to authenticate with bridge' });
                }
            });
    }
    else {
        // Username already exists, just return success
        res.sendStatus(200);
    }
})

//gets main page
app.get('/', function (req, res) {
    var cookie = req.cookies.Huesername;
    if (cookie === undefined) {
        res.sendFile(__dirname + '/setup.html');
    }
    else {
        username = cookie;
        init();
        res.sendFile(__dirname + '/index.html');
    }
});

// Add endpoint to clear credentials and re-authenticate
app.get('/reset', function (req, res) {
    username = "";
    res.clearCookie('Huesername');
    res.redirect('/');
});

function setLights(lights, state) {
    if (!api) {
        console.error('API not initialized');
        return;
    }

    // Add null check for lights array
    if (!lights || !Array.isArray(lights)) {
        console.error('Lights array is undefined or not an array');
        return;
    }

    for (var i = 0; i < lights.length; i++) {
        api.lights.setLightState(parseInt(lights[i], 10), state)
            .catch(function (err) {
                console.error('Error setting light state:', err);
            });
    }
}

//define variables for post
var prev_high = true;
var lightState = v3.lightStates.LightState;
var highstate = new lightState().transitiontime(1).on(true);
var lowstate = new lightState().transitiontime(1).on(true);
//post request to recieve sound frequency data
app.post('/hueData', function (req, res) {

    //get color & brightness values
    var hue = req.body["hue"];
    var bri = req.body["brightness"];
    var low = req.body["low"];

    // Ensure brightness is within valid range (1-254)
    bri = Math.max(1, Math.min(254, bri));

    // Ensure hue is within valid range (0-1) before multiplication
    // If hue is negative or greater than 1, wrap it around
    if (hue < 0) {
        hue = hue % 1 + 1;
    } else if (hue > 1) {
        hue = hue % 1;
    }

    // Convert to Philips Hue scale (0-65535)
    var hueValue = Math.round(hue * 65535);
    // Final safety check
    hueValue = Math.max(0, Math.min(65535, hueValue));

    // Calculate different color for lows group
    // Option 1: Complementary color (opposite on color wheel)
    //var lowHueValue = (hueValue + 32768) % 65536;

    // Option 2: Shifted hue (warmer colors for lows, cooler for highs)
    //var lowHueValue = Math.round((hue * 0.3) * 65535); // Reds/oranges for lows

    // Option 3: Inverted mapping (high frequencies = low hue values for lows)
    var lowHueValue = Math.round((1 - hue) * 65535);

    //if it's a low frequency
    if (low) {
        lowstate.hue(lowHueValue).bri(bri);
        //only adjust high frequency brightness if it goes from high to low
        if (prev_high) {
            // Ensure the calculated brightness stays within valid range
            var adjustedBri = Math.max(1, bri - 175);
            highstate.bri(adjustedBri);
            prev_high = false;
        }
    }
    //high freq
    else {
        highstate.hue(hueValue).bri(bri);
        //only adjust low frequency brightness if it goes from low to high
        if (!prev_high) {
            // Ensure the calculated brightness stays within valid range
            var adjustedBri = Math.max(1, bri - 175);
            lowstate.bri(adjustedBri);
            prev_high = true;
        }
    }

    //make api calls
    if (typeof api != 'undefined' && highs && lows) {
        setLights(highs, highstate);
        setLights(lows, lowstate);
    } else {
        console.error('API not initialized or light groups not found');
    }

    //OK
    res.sendStatus(200);
});
