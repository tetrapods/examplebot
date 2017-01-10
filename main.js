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
   endpoint("/resolved", doResolved);
   endpoint("/added", doAdded);
   endpoint("/removed", doRemoved);
   endpoint("/message", doMessage);
   endpoint("/offer", doOffer);
   server = app.listen(options.port, function () {
     console.log('Example app listening on port %s', server.address().port);
   });
   // do something asynchronously
   setInterval(doSomething, 1000000);
   
}

function endpoint(endpoint, handler) {
   app.post(endpoint, function(req, res) {
      res.succeed = function (obj) {
         obj = obj || {};
         obj.success = "true";
         console.log('resp> SUCCESS %s', JSON.stringify(obj));
         this.status(200).send(obj);
      };
      res.fail = function (text) {
         console.log('resp> FAIL %s', text);
         this.status(200).send({success: "false", text: text});
      };
      response = res;
      if (!req.body) {
         res.fail("Missing comand or action");
         return;
      }
      handler(req.body);
   });
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

function asyncHandoff(queueId) {
   var data = {
      token: options.chatboxToken,
      queueId: queueId
   };
   asyncSend(data, "/handoff");
}

function asyncResolve(queueId) {
   var data = {
      token: options.chatboxToken,
      queueId: queueId
   };
   asyncSend(data, "/resolve");
}

function asyncLeave(roomId) {
   var data = {
      token: options.chatboxToken,
      roomId: roomId
   };
   asyncSend(data, "/leaveRoom", function() {
      console.log("==== Left Room " + roomId + " ====");
      removeRoom(roomId);
   });
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

function asyncAddInteractive(roomId) {
   var data = {
      token: options.chatboxToken,
      customerId: options.byRoom[roomId].userId,
      interactiveId: options.defaultInteractiveId
   };

   var action;
   var mediaType = options.byRoom[roomId].mediaType;
   if (mediaType && mediaType == "sms") {
      action = "/smsInteractive";
      data.message = "Come take a look at this {link}";
   } else {
      action = "/makeInteractive"
   }

   asyncSend(data, action, function(body) {
      console.log("==== Adding interactive to " + roomId + " ====");
   });
}

function asyncSend(data, location, callback, tries) {
   tries = tries || 1;
   console.log("POST " + location + " " + JSON.stringify(data));
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

function doResolved(body) {
   response.succeed();
   console.log("Room marked as resolved, history:");
   console.log(body.messages);
   console.log("Going to leave the room");
   asyncLeave(body.roomId);
}

function doAdded(body) {
   response.succeed();
   if(addRoom(body.roomId, body.userId)){
      asyncSay("Thank you for having me, it's great to be here!", { suppressWelcome: true }, body.roomId);
   }
}

function doRemoved(body) {
   response.succeed();
   removeRoom(body.roomId);
}

function doMessage(body) {
   response.succeed();
   if (body.content.indexOf("#handoff") >= 0) {
      asyncWhisper("I am asking for some human assistance, sync", body.roomId);
      asyncHandoff(body.queueId);
   } else if (body.content.indexOf("#resolve") >= 0) {
      asyncWhisper("I am resolving, sync", body.roomId);
      asyncResolve(body.queueId);
   } else if (body.content.indexOf("#history") >= 0) {
      asyncWhisper("I am asking for the history", body.roomId);
      asyncHistory(body.roomId);
   } else if (body.content.indexOf("#interactive") >= 0) {
      asyncWhisper("I am adding an interactive", body.roomId);
      asyncAddInteractive(body.roomId);
   } else {
      if (body.visibility == "whisper") {
         asyncWhisper("Sssh <b>" + body.userName + "</b>, you I can hear you ", body.roomId);
      } else {
         if (body.mediaType == "sms") {
            asyncSay("Hello there " + body.userName + "  you spoke and I heard " + body.content, body.roomId, "sms");
         } else {
            asyncSay("Hello there <b>" + body.userName + "</b> you spoke and I heard <i title=\'" + JSON.stringify(body) + "\'>" + body.content + "</i>", body.roomId);
         }
      }
   }
}

function doOffer(body) {
   var routing = body.routing;
   var contents = body.contents;
   var username = body.userName;
   var userId = body.userId;
   var roomId = body.roomId;
   var channel = body.channel == "sms" ? "sms": undefined;

   if (contents.length == 0) {
      response.fail("offer with empty contents");
      return;
   }
   
   // fake auto-ignore and auto-skip by just looking for #skip and #ignore in message
   if (routing == "automatic") {
      if (S(contents[0]).contains("#skip")) {
         response.succeed({ action: "skip" });
         return;
      }
      if (S(contents[0]).contains("#ignore")) {
         response.succeed({ action: "ignore" });
         return;
      }
   }
   
   response.succeed({ action: "take" });
   addRoom(body.roomId, userId, channel);
   asyncSay("Enter, if you dare {chatbox}",roomId, channel);
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
      options.defaultInteractiveId = 1;
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

function addRoom(roomId, userId, mediaType) {
   if (!options.byRoom[roomId]) {
      options.byRoom[roomId] = {userId: userId, mediaType: mediaType};
      options.rooms.push(roomId);
      saveOptions();
      return true;
   }
   return false;
}

function removeRoom(roomId) {
   options.byRoom[roomId] = null;
   var ix = options.rooms.indexOf(roomId);
   options.rooms.splice(ix, 1);
   saveOptions();
}

