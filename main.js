var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');
var S = require("string");
var fs = require("fs");

var options, optionsFilename;
var app, server, response;

main();

function main() {
   loadOptions();
   app = express();
   app.use(bodyParser.json());
   app.use(function(req, res, next) {
     console.log('  in> %s %s %s', req.method, req.path, JSON.stringify(req.body));
     next();
   });
   app.post('/chatbox', function(req, res) {
      res.succeed = function(obj) {
         obj = obj || {};
         obj.success = "true"
         console.log('resp> SUCCESS %s', JSON.stringify(obj));
         this.status(200).send(obj);
      };
      res.fail = function(text) {
         console.log('resp> FAIL %s', text);
         this.status(200).send({ success: "false", text: text });
      };
      response = res;
      chatbox(req.body);
   });
   server = app.listen(options.port, function () {
     console.log('Example app listening on port %s', server.address().port);
   });
   // do something asynchronously
   setInterval(doSomething, 1000000);
   
}

//---------------- asynchronous part of the protocol

function doSomething() {
   var id = getRandomRoom();
   if (id) {
      request('http://api.icndb.com/jokes/random', function(error, response, body) {
         body = JSON.parse(body);
         var joke = body.type == "success" ? body.value.joke : "fail"
         asyncSay(joke, id);
      });
   }
}

function asyncSay(text, roomId, mediaType) {
   var data = {
      token: options.chatboxToken,
      content: text,
      roomId: roomId,
      mediaType: mediaType || "html",
      id: new Date().getTime()
   };
   asyncSend(data, "/chat");
}

function asyncWhisper(text, roomId, mediaType) {
   var data = {
      token: options.chatboxToken,
      content: text,
      roomId: roomId,
      mediaType: mediaType || "html",
      id: new Date().getTime()
   };
   asyncSend(data, "/whisper");
}

function asyncHandoff(text, roomId) {
   var data = {
      token: options.chatboxToken,
      text: text,
      roomId: roomId
   };
   asyncSend(data, "/handoff");
}

function asyncResolve(roomId) {
   var data = {
      token: options.chatboxToken,
      roomId: roomId
   };
   asyncSend(data, "/resolve");
}

function asyncHistory(roomId) {
   var data = {
      token: options.chatboxToken,
      roomId: roomId
   };
   asyncSend(data, "/history", function(body) {
      console.log("==== History for Room " + roomId + " ====");
      console.log(body);
   });
}

function asyncSend(data, location, callback, tries) {
   tries = tries || 1;
   console.log("post> " + JSON.stringify(data));
   request({
      method: 'POST',
      uri: options.chatboxURL + location,
      json: true,
      gzip: true,
      body: data
   }, function(error, response, body) {
      if (!response) {
         // unable to complete request successfully, try later
         console.log("fail> empty");
         retry();
      } else {
         switch (response.statusCode) {
            case 200:
               // success!
               console.log("success> " + JSON.stringify(body));
               if (callback) callback(body);
               break;
            case 401:
               // maintenance, try later
               console.log("fail-401> " + JSON.stringify(body));
               retry();
               break;
            case 404:
               // insufficient rights
               console.log("fail-404> " + JSON.stringify(body));
               console.log(" err> insufficient rights to post to %s", options.chatboxURL + location)
               break;
            default:
               console.log("fail-" + response.statusCode + "> " + JSON.stringify(body));
               break;
         }
      }
   });
   
   function retry() {
      // this retries for about 6 minutes, which is probably more patience than customers will show
      if (tries < 10) {
         var tm = tries * tries * 1000;
         setTimeout(function() { asyncSend(data, location, callback, tries+1)}, tm);
      } else {
         console.log(" err> ran out of tries to post to %s", options.chatboxURL + location);
      }
   }
}

//----------------- synchronous part of the protocol

function chatbox(body) {
   if (!body || !body.action) {
      response.fail("Missing comand or action");
      return;
   }
   switch (body.action) {
      case "resolved":
         console.log("Room marked as resolved, history:");
         console.log(body.messages);
         break;
      case "added":
         addRoom(body.roomId);
         replySay("Thank you for having me, it's great to be here!", { suppressWelcome: true });
         break;
      case "removed":
         removeRoom(body.roomId);
         response.succeed();
         break;
      case "chat":
         onChat(body);
         break;
      case "fromQueue":
         fromQueue(body);
         break;
      default:
         response.fail("Unknown action " + body.action);
         break;
   }
}

function onChat(body) {
   addRoom(body.roomId);
   var async = S(body.content).contains("#async");
   if (S(body.content).contains("#handoff")) {
      if (async) {
         replyWhisper("I am asking for some human assistance, async");
         asyncHandoff("Hellooo, any humans out there?", body.roomId);
      } else {
         asyncWhisper("I am asking for some human assistance, sync", body.roomId);
         replyHandoff("Hellooo, any humans out there?");
      }
      return;
   }
   if (S(body.content).contains("#resolve")) {
      if (async) {
         replyWhisper("I am resolving, async");
         asyncResolve(body.roomId);
      } else {
         asyncWhisper("I am resolving, sync", body.roomId);
         replyResolve();
      }
      return;
   }
   if (S(body.content).contains("#history")) {
      replyWhisper("I am asking for the history");
      asyncHistory(body.roomId);
      return;
   }
   if (body.visibility == "whisper") {
      replyWhisper("Sssh <b>" + body.userName + "</b>, you I can hear you <i title=\'" + JSON.stringify(body) + "\'>whisper</i>");
   } else {
      replySay("Hello there <b>" + body.userName + "</b> you spoke and I heard <i title=\'" + JSON.stringify(body) + "\'>" + body.content + "</i>");
   }
}

function fromQueue(body) {
   var allowed = body.allowed;
   var routing = body.routing;
   var contents = body.contents;
   var username = body.userName;
   var userId = body.userId;
   
   if (contents.length == 0) {
      response.fail("fromQueue with empty contents");
      return;
   }
   
   if (routing == "automatic") {
      // fake auto-ignore and auto-skip by just looking for #skip and #ignore in message
      if (S(contents[0]).contains("#skip") && allowed.indexOf("skip") >= 0) {
         response.succeed({ action: "skip" });
         return;
      }
      if (S(contents[0]).contains("#ignore") && allowed.indexOf("ignore") >= 0) {
         response.succeed({ action: "ignore" });
         return;
      }
   }
   
   if (allowed.indexOf("take") >= 0) {
      response.succeed({ action: "take", text: "Enter, if you dare {chatbox}" });
      return;
   }
   
   response.fail("Unable to decide what to do with %s", JSON.stringify(body));
}

function replySay(text, options) {
   var obj = options || {};
   obj.action = "chat";
   obj.content = text;
   obj.mediaType = "html";
   response.succeed(obj);
}

function replyWhisper(text, options) {
   var obj = options || {};
   obj.action = "whisper";
   obj.content = text;
   obj.mediaType = "html";
   response.succeed(obj);
}

function replyHandoff(text, options) {
   var obj = options || {};
   obj.action = "handoff";
   obj.text = text;
   response.succeed(obj);
}

function replyResolve(options) {
   var obj = options || {};
   obj.action = "resolve";
   response.succeed(obj);
}

//--------------------- misc functions

function loadOptions() {
   var args = process.argv.slice(2);
   optionsFilename = args.length > 0 ? args[0] : "examplebot.opts";

   if (fs.existsSync(optionsFilename)) {
      var text = fs.readFileSync(optionsFilename, "utf8");
      options = JSON.parse(text);
   } else {
      options = {};
      options.chatboxToken = "unknown";
      options.chatboxURL = "https://unknown/api/v1";
      options.rooms = [];
      options.byRoom = {};
      options.port = 7111;
      saveOptions();
      console.log("Please edit " + optionsFilename + " to have the proper values for chatbox URL and token");
      process.exit(0);
   }
}

function saveOptions() {
   fs.writeFileSync(optionsFilename, JSON.stringify(options, null, 3), "utf8");
}

function getRandomRoom() {
   if (options.rooms.length > 0) {
      var ix = Math.floor(Math.random() * options.rooms.length);
      return options.rooms[ix];
   }
}

function addRoom(roomId) {
   if (!options.byRoom[roomId]) {
      options.byRoom[roomId] = roomId;
      options.rooms.push(roomId);
      saveOptions();
   }
}

function removeRoom(roomId) {
   options.byRoom[roomId] = null;
   var ix = options.rooms.indexOf(roomId);
   options.rooms.splice(ix, 1);
   saveOptions();
}

