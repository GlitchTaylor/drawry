/*
    picturephone
    server.js
    a multiplayer art experiment by Riley Taylor (rtay.io)
*/
"use strict";

// Including libraries
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const http = require('http');
const xss = require("xss");
const path = require('path');
const sizeOf = require('image-size');

// Server side variables (to keep track of games)
const CLIENTS = [];
const SOCKETS = [];
const ROOMS = {};

// Other constants
const VERBOSE = true;
const MAX_ROOM_SIZE = 10;
const SETTINGS_DEFAULT = {
    firstPage: 'Write',
    pageCount: '8',
    pageOrder: 'Normal',
    palette: 'No palette',
    timeWrite: '0',
    timeDraw: '0'
};
const SETTINGS_CONSTRAINTS = {
    firstPage: ['string', ['Write', 'Draw']],
    pageCount: ['number', [2, 20]],
    pageOrder: ['string', ['Normal', 'Random']],
    palette: ['string', ['No palette']],
    timeWrite: ['number', [0, 15]],
    timeDraw: ['number', [0, 15]]
};
const STATE = {
    LOBBY: 0,
    PLAYING: 1,
    PRESENTING: 2,
    END: 3
};


///// ----- ASYNC SERVER FUNCTIONS ----- /////
// Listen for incoming connections from clients
io.on('connection', (socket) => {

    CLIENTS[socket.id] = {};
    SOCKETS[socket.id] = socket;


    /// --- LOBBY --- ///

    // Listen for client joining room
    socket.on('joinRoom', (data) => {
        if (VERBOSE) {
            console.log('joinRoom', data.id, {name: data.name, room: data.room});
        }

        // first of all, make sure no two clients connect with the same ID
        for (let _socketID in CLIENTS) {
            if (data.id === CLIENTS[_socketID].id) {
                // disconnect client with matching ID
                SOCKETS[_socketID].disconnect();
            }
        }

        // fetch client values
        let _client = CLIENTS[socket.id];
        _client.id = xss(data.id.substr(0, 10)).replace(/[^0-9]/g, '') || 0;
        _client.name = xss(data.name.substr(0, 32));
        _client.room = xss(data.room.substr(0, 8)).replace(/[^a-zA-Z0-9-_]/g, '') || 0;

        if (_client.id && _client.room) {
            // add client to the room
            socket.join(_client.room);

            // if room doesn't exist, create it and make client the host
            if (!ROOMS.hasOwnProperty(_client.room)) {
                // create room
                ROOMS[_client.room] = {
                    clients: [],
                    host: socket.id,
                    settings: SETTINGS_DEFAULT,
                    state: STATE.LOBBY,
                    page: 0,
                    submitted: 0,
                    books: undefined
                }
            }

            // check if room can be joined
            let _room = ROOMS[_client.room];
            if (_room.clients.length < MAX_ROOM_SIZE && _room.state === STATE.LOBBY) {
                // if room isn't full and is in lobby, add client to the room
                _room.clients.push(socket.id);

                // inform the client they've joined the room
                io.to(socket.id).emit("joined", {
                    room: _client.room,
                    users: Object.values(CLIENTS).filter((c) => {
                        return c.room === _client.room && c.id !== _client.id
                    }),
                    host: CLIENTS[ROOMS[_client.room].host].id,
                    settings: ROOMS[_client.room].settings
                });

                // inform users in the room about the new client
                socket.to(_client.room).emit("userJoin", CLIENTS[socket.id]);

            } else {
                // room is full, boot client
                io.to(socket.id).emit("disconnect", "server full");
            }
        } else {
            // ID or roomID is invalid, boot client
            io.to(socket.id).emit("disconnect");
        }
    });

    // Listen for room settings changes
    socket.on('settings', (data) => {
        if (VERBOSE) {
            console.log('settings', CLIENTS[socket.id].id, data.settings);
        }

        let _roomID = CLIENTS[socket.id].room;
        let _room = ROOMS[_roomID];

        // Make sure user is the host and settings are within constraints
        if (socket.id === _room.host && verifySettings(data.settings)) {
            // Host updating settings
            _room.settings = data.settings;

            // Propogate settings to other clients
            socket.to(_roomID).emit("settings", _room.settings);

        } else {
            // Invalid request, kick from game
            socket.disconnect();
        }
    });


    /// --- GAME --- ///

    // Start the game for the room
    socket.on('startGame', (data) => {
        if (VERBOSE) {
            console.log('startGame', CLIENTS[socket.id].id, data.settings);
        }

        let _roomID = CLIENTS[socket.id].room;
        let _room = ROOMS[_roomID];

        // Make sure user is the host, player count is reached, and settings are valid
        if (socket.id === _room.host && _room.clients.length >= 2 && verifySettings(data.settings) && _room.state === STATE.LOBBY) {
            // Update settings, change room state
            _room.settings = data.settings;
            _room.state = STATE.PLAYING;
            _room.page = 0;

            // Generate page assignment order for books
            generateBooks(_room);

            // Start game
            io.to(_roomID).emit('startGame', {books: _room.books, start: _room.settings.firstPage});

        } else {
            // Invalid request, kick from game
            socket.disconnect();
        }
    });

    // Update a player's book title
    socket.on('updateBookTitle', (data) => {
        if (VERBOSE) {
            console.log('updateBookTitle', CLIENTS[socket.id].id, {title: data.title});
        }

        let _id = CLIENTS[socket.id].id;
        let _roomID = CLIENTS[socket.id].room;
        let _room = ROOMS[_roomID];

        // make sure to sanitise title string
        let _title = xss(data.title.substr(0, 40));

        // send title to other players
        if (_room.page === 0) {
            socket.to(_roomID).emit("bookTitle", {id: _id, title: _title});
        }
    });

    // Get writing page from player
    socket.on('submitPage', (data) => {
        if (VERBOSE) {
            console.log('submitPage', CLIENTS[socket.id].id, {
                type: data.type,
                value: data.value.substr(0, 63) + (data.value.length > 63 ? "…" : "")
            });
        }
        let _id = CLIENTS[socket.id].id;
        let _roomID = CLIENTS[socket.id].room;
        let _room = ROOMS[_roomID];
        let _value = undefined;

        // Fetch page data
        if (data.type === "Write") {
            // Data is text
            _value = xss(data.value.substr(0, 80));

        } else if (data.type === "Draw") {
            // Data is encoded image
            // make sure the image is expected format
            if (data.value.indexOf('data:image/png;base64,') === 0) {
                let img = Buffer.from(data.value.split(';base64,').pop(), 'base64')
                let dimensions = sizeOf(img);

                // make sure image is correct size
                if (dimensions.width === 800 && dimensions.height === 600) {
                    _value = data.value;
                } else {
                    // if it's not the correct size, check if it's within a reasonable tolerance range (1%)
                    let _diffWidth = Math.abs(dimensions.width - 800);
                    let _diffHeight = Math.abs(dimensions.height - 600);
                    if (_diffWidth < 8 && _diffHeight < 6) {
                        // Send image data anyway, it's close enough
                        _value = data.value;
                        // TODO: Either resize on server or tell client to resize image?
                    } else {
                        console.log("ERROR unexpected image size", [dimensions.width, dimensions.height]);
                    }
                }
            } else {
                console.log("ERROR unexpected image format", {format: data.value.substr(0, 22)});
            }
        }

        // Identify book ID to update
        let _bookID;
        for (let i of Object.keys(_room.books)) {
            if (_room.books[i][_room.page] === _id) {
                _bookID = i;
                break;
            }
        }

        // Verify data.type is valid
        let _expected = ((_room.settings.firstPage === "Write") ^ (_room.page % 2)) ? "Write" : "Draw";
        if (_expected !== data.type) {
            // Client trying to send tampered data, overwrite
            _value = undefined;
            console.log("ERROR unexpected data.type", {received: data.type, expected: _expected})
        }

        // Send page data to all players
        io.to(_roomID).emit('page', {id: _bookID, page: _room.page, value: _value, author: _id});

        // Check if all players have submitted
        _room.submitted += 1;
        if (_room.submitted === _room.clients.length) {
            _room.submitted = 0;
            _room.page += 1;

            if (_room.page === parseInt(_room.settings.pageCount)) {
                // Finished creation part of game, move to presenting
                _room.state = STATE.PRESENTING;
                io.to(_roomID).emit('startPresenting')
            } else {
                // Go to next page
                io.to(_roomID).emit('nextPage');
            }
        }
    });


    /// --- PRESENTING --- ///

    // Let the host choose which book to present


    // Go to next page of presentation


    // Go to previous page of presentation (hide most recently shown page)


    // Return to lobby for next book


    /// --- END --- ///

    // Listen for disconnect events
    socket.on('disconnect', (data) => {
        if (VERBOSE) {
            console.log('disconnect', CLIENTS[socket.id].id, {type: data});
        }

        if (CLIENTS[socket.id].id && CLIENTS[socket.id].room) {
            // remove client from the room if they've joined one
            let _id = CLIENTS[socket.id].id;
            let _roomID = CLIENTS[socket.id].room;
            let _room = ROOMS[_roomID];

            // alert others that client has left the room
            socket.to(_roomID).emit('userLeave', _id);

            if (_room) {
                // remove client from the room
                let _clients = _room.clients;
                let _index = _clients.indexOf(socket.id);
                if (_index !== -1) {
                    _clients.splice(_index, 1);
                }

                // delete the room if everyone has left
                if (_clients.length === 0) {
                    delete ROOMS[_roomID];
                } else {
                    // if the host disconnected, assign a new host
                    if (socket.id === _room.host) {
                        _room.host = _clients[0];
                        socket.to(_roomID).emit("userHost", CLIENTS[_room.host].id);
                    }
                }
            }
        }

        delete CLIENTS[socket.id];
    });
});

// Simple HTTP server
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});
app.use(express.static('static'));

// Open server to manage server things
server.listen(process.env.PORT || 80);


///// ----- SYNCHRONOUS SERVER FUNCTIONS ----- /////
// Ensure game settings are within reasonable constraints
function verifySettings(settings) {
    let _valid = true;

    for (let _rule in settings) {
        let _setting = settings[_rule];
        let _constraint = SETTINGS_CONSTRAINTS[_rule];

        switch (_constraint[0]) {
            case('string'):
                // Ensure string is in the list of valid strings
                if (!_constraint[1].includes(_setting)) {
                    _valid = false;
                }
                break;
            case('number'):
                // Ensure value is a valid integer, and is within the valid range
                if (/^[0-9]+$/.test(_setting)) {
                    _setting = +_setting;
                    if (_setting < _constraint[1][0] || _setting > _constraint[1][1]) {
                        _valid = false;
                    }
                } else {
                    _valid = false;
                }
                break;
        }
    }

    return _valid;
}

// Generate books for a room
function generateBooks(room) {
    // create books
    room.books = {};
    room.clients.forEach((id) => {
        room.books[CLIENTS[id].id] = [CLIENTS[id].id.toString()];
    });
    let _players = Object.keys(room.books);

    // assign pages
    if (room.settings.pageOrder === "Normal") {
        // normal order (cyclical)
        for (let i = 1; i < room.settings.pageCount; i++) {
            for (let j = 0; j < _players.length; j++) {
                room.books[_players[(j + i) % _players.length]].push(_players[j]);
            }
        }
    } else if (room.settings.pageOrder === "Random") {
        // random order
        let _assigned = [_players]; // variable to keep track of previous rounds

        for (let i = 1; i < room.settings.pageCount; i++) {
            let _prev = _assigned[i - 1];
            let _next = _prev.slice(); // copy previous array

            // randomly shuffle
            shuffle(_next);

            // ensure no pages match the previous round
            for (let j = 0; j < _players.length; j++) {
                if (_prev[j] === _next[j]) {
                    // pages match, generate random index to swap with
                    let _swap = Math.floor(Math.random() * (_players.length - 1));
                    if (_swap >= j) {
                        _swap += 1;
                    }

                    // swap values
                    [_next[j], _next[_swap]] = [_next[_swap], _next[j]];
                }
            }

            // add round to books
            _assigned.push(_next);
            for (let j = 0; j < _players.length; j++) {
                room.books[_players[j]].push(_next[j]);
            }
        }
    }
}

// Shuffle array (fisher yates)
function shuffle(array) {
    var m = array.length, t, i;
    while (m) {
        i = Math.floor(Math.random() * m--);
        t = array[m];
        array[m] = array[i];
        array[i] = t;
    }
    return array;
}