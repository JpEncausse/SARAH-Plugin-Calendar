var fs         = require('fs');
var readline   = require('readline');
var google     = require('googleapis');
var googleAuth = require('google-auth-library');

var rfc_3339   = 'YYYY-MM-DD[T]HH:mm:ssZ'
var moment     = require('moment');
    moment.locale('fr');

// ------------------------------------------
//  SARAH
// ------------------------------------------

exports.init = function(){ 
  authorize(function(auth){ /*  NONE  */ });
}

exports.action = function(data, next){  
  if (data.check) {
    checkCalendar(data, function(json){
      if (!json){ return next({ "tts" : i18n('plugin.calendar.noEvent') }); }
      next(json);
    });
  } else {
    createCalendar(data, next);
  }
}

exports.cron = function(next){
  checkCalendar({}, next);
}

// ------------------------------------------
//  CHECK
// ------------------------------------------

var checkCalendar = function(data, callback){
  var config = Config.modules.calendar;
  authorize(function(auth){ 
    
    listEvents(auth, config.calendar_id, function(events){
      if (!events) return callback();
      
      // Next 5 minutes OR next day
      var start  = new moment();
      var end    = new moment(start).add(5, 'minutes');
      if (data.check == 'tomorrow'){
        start = start.add(1, 'day').set('hour', 0).set('minute', 0);
        end   = new moment(start).add(1, 'day');
      }
      
      // Filter date/time
      var events = events.filter(function(event){
        var begin = moment(event.start.dateTime, rfc_3339);
        if (data.check != 'tomorrow' && !event.reminders.useDefault){
          begin = begin.subtract(event.reminders.overrides[0].minutes, 'minutes');
        }
        
        return begin.isBetween(start, end) ? event : undefined;
      });

      // Build TTS
      var tts = "";
      events.map(function(event){ 
        var begin = moment(event.start.dateTime, rfc_3339);
        if (event.location && event.location.indexOf('http') == 0){
          
          info('[Event] trigger: ' + event.location);
          var request = require('request'); 
          request({ 'uri' : event.location }, function (err, response, body){
            if (err || response.statusCode != 200) { warn('Error calling:', event.location); return callback(); }
            tts += body + ' ';
          });
          
        } else if (event.summary){
          tts += i18n("plugin.calendar.inEvent", begin.format("HH"), begin.format("mm"), event.summary) + '. ';
        }
        
      })
      
      callback({ "events": events, "tts": tts });
    });
    
  });
}

// ------------------------------------------
//  CREATE
// ------------------------------------------

// ruleAddEvent:    title=Rendez-Vous&Day=11&Month=12&Year=2014&IsValidDate=true&Hour=18&Minute=0
// ruleAddReminder: relativeTime=true&minute=5

var createCalendar = function(data, callback){
  var config = Config.modules.calendar;
  authorize(function(auth){
    
    var start = new moment();
    var end   = new moment();
    
    if (data.relativeTime){
      
           if (data.hour)   end.add(data.hour,   'hour');
      else if (data.minute) end.add(data.minute, 'minute');
      else if (config.memo) end.add(config.memo, 'minute');
      
    } else if (data.Year && data.Month && data.Day && data.Hour && data.Minute) {
      
      start.set('year'  , data.Year);
      start.set('month' , data.Month);
      start.set('date'  , data.Day);
      start.set('hour'  , data.Hour);
      start.set('minute', data.Minute);
      end = new moment(start).add(data.duration || config.event, 'minute');
      
    } else { return callback(); }
    
    createEvent(auth, config.calendar_id, {
      'summary': data.title || data.dictation || 'Rappel',
      'start': { dateTime: start.format(rfc_3339), 'timeZone': 'Europe/Paris' },
      'end':   { dateTime: end.format(rfc_3339)  , 'timeZone': 'Europe/Paris' },
      'description': config.details
    },
    function(){ callback(); });
    
  });
}

// ------------------------------------------
//  GOOGLE CALENDAR : AUTHENTICATION
// ------------------------------------------

var SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(callback) {
  var config = Config.modules.calendar;
  var clientSecret = config.calendar_secret;
  var clientId = config.calendar_clientid;
  var redirectUrl = config.calendar_redirect_uris;
  var auth = new googleAuth();
  var oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

  // Check if we have previously stored a token.
  if (!config.calendar_expiry_date) {
    getNewToken(oauth2Client, callback);
  } else {
    oauth2Client.credentials = {
      "access_token"  : config.calendar_access_token,
      "token_type"    : config.calendar_token_type  ,
      "refresh_token" : config.calendar_refresh_token,
      "expiry_date"   : config.calendar_expiry_date 
    };
    callback(oauth2Client);
  }
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
function getNewToken(oauth2Client, callback) {
  var authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  warn('>>> Authorize this app by visiting this url: ', authUrl);
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('>>> Enter the code from that page here: ', function(code) {
    rl.close();
    oauth2Client.getToken(code, function(err, token) {
      if (err) {
        info('Error while trying to retrieve access token', err);
        return;
      }
      oauth2Client.credentials = token;
      storeToken(token);
      callback(oauth2Client);
    });
  });
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token) {
  var config = Config.modules.calendar;
  config.calendar_access_token  = token.access_token;
  config.calendar_token_type    = token.token_type;
  config.calendar_refresh_token = token.refresh_token;
  config.calendar_expiry_date   = token.expiry_date;
  SARAH.ConfigManager.save();
  info('Token stored in properties');
}

// ------------------------------------------
//  GOOGLE CALENDAR : API
// ------------------------------------------

/**
 * Lists the next 10 events on the user's calendar.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
var listEvents = function(auth, calendar_id, callback) {
  var calendar = google.calendar('v3');
  calendar.events.list({
    auth: auth,
    calendarId: calendar_id,
    timeMin: (new Date()).toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime'
  }, function(err, response) {
    
    if (err) {
      info('The API returned an error: ' + err);
      return callback();
    }
    
    var events = response.items;
    if (events.length == 0) {
      info('No upcoming events found.');
    }
    callback(events);
  });
}

var createEvent = function(auth, calendar_id, event, callback){

  var calendar = google.calendar('v3');
  calendar.events.insert({
    auth: auth,
    calendarId: calendar_id,
    resource: event
  }, function(err, event) {
    
    if (err) {
      info('The API returned an error: ' + err);
      return callback();
    }
    callback(event);
  });
}

