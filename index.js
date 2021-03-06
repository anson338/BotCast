const config = require('./config');
const moment = require('moment');
const fs = require('fs');

const TelegramBot = require('node-telegram-bot-api');
const Slack = require('node-slack');
const Discord = require('discord.io');
const Twitter = require('twit');

const emoji = require('node-emoji');

const Feed = require('feed')

const env = require('node-env-file');
env(__dirname + '/.env');

if(!process.env.TELEGRAM_TOKEN) {
  console.log('missing TELEGRAM_TOKEN in .env file');
  return null;
}
const telegram_bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});

telegram_bot.on('polling_error', (error) => {
  console.log(error);
  console.log('TELEGRAM_TOKEN already connected somewhere else');
  process.exit();
});

const COMMANDS = [
  /\/register/,
  /\/weekly/,
  /\/get_id/,
];

var url_expression = /\b((?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/i;
var url_regex = new RegExp(url_expression);

telegram_bot.onText(/\/register/, function getId(msg) {

  if(msg.chat.type != 'private')
    return null;

  telegram_bot.sendMessage(msg.chat.id, 'registered');
});

telegram_bot.onText(/\/weekly/, function getId(msg) {

  if(msg.chat.type != 'private')
    return null;

  if(fs.existsSync('parasol.json')) {
    network = JSON.parse(fs.readFileSync('parasol.json', 'utf8'));
  }

  content = network.nodes.filter( node => {
    return node.metadata.actions
      .map( action => action.type )
      .indexOf('tag_entheogen') != -1 &&
    /\/tag_/.test(node.label) == false
  }).map( node => {
    return '[' + node.label + '](' + node.label +')';
  }).join('\n');

  telegram_bot.sendMessage(msg.chat.id, content, {
    parse_mode: 'markdown',
    disable_web_page_preview: true,
  });
});

// helper to fetch group chat id to fill config.js
telegram_bot.onText(/\/get_id/, function getId(msg) {
  if(msg.chat.username != config.owner)
    return null;
  telegram_bot.sendMessage(msg.chat.id, msg.chat.id);
});

telegram_bot.on('message', (msg) => {

  if(msg.chat.type != 'private' || msg.chat.username != config.owner)
    return null;

  let is_command = false;
  COMMANDS.forEach(command => {
    if(command.test(msg.text)) {
      is_command = true;
    }
  });
  if(is_command)
    return null;

  const chatId = msg.chat.id;

  if(config.exports && config.exports.submit && config.exports.submit.length > 0) {

    config.exports.submit.forEach( output => {

      switch(output.method) {
        case 'json':

          let json_content = {};
          if(fs.existsSync(output.path)) {
            json_content = JSON.parse(fs.readFileSync(output.path, 'utf8'));
          }

          if(!json_content.items)
            json_content.items = [];

          let item = json_content.items.find( item => {
            return item.text == msg.text;
          });

          if(item) {
            item.actions.push({action: 'submitted', timestamp: moment().unix()});
          } else {
            const parsedUrl = url_regex.exec(msg.text);
            let url = null;
            if(parsedUrl && parsedUrl.length > 0)
              url = parsedUrl[0];

            json_content.items.push({
              url: url,
              text: msg.text,
              actions: [{action: 'submitted', timestamp: moment().unix()}]
            });
          }

          fs.writeFileSync(output.path, JSON.stringify(json_content, null, 4));
          break;
        case 'csv':
          const content = moment().unix() + ',submitted,' + msg.text.replace(/(\r\n|\n|\r)/gm, ' ') + '\n';
          fs.appendFileSync(output.path, content);
          break;

        case 'network_json':

          let network = {};
          if(fs.existsSync(output.path)) {
            network = JSON.parse(fs.readFileSync(output.path, 'utf8'));
          }

          if(!network.nodes)
            network.nodes = [];

          let text_node = network.nodes.find(node => node.label == msg.text);

          if(!text_node) {
            text_node = {
              id: network.nodes.length,
              label: msg.text,
              size: 1,
              x: Math.random(),
              y: Math.random(),
              metadata: {
                category: 'action',
                actions: [{type: 'submitted', timestamp: moment().unix()}],
              }
            };
            network.nodes.push(text_node);
          } else {
            text_node.metadata.actions.push({type: 'submitted', timestamp: moment().unix()});
          }

          fs.writeFileSync(output.path, JSON.stringify(network, null, 2));
          break;
      };

    });

  }

  let keyboard = [];
  const keyboard_row_count = Math.max.apply(
    Math,
    config.connectors.map(connector => connector.row)
  );
  for(let i = 0; i <= keyboard_row_count; i++) {
    keyboard.push(config.connectors
                  .filter(connector => connector.row == i)
                  .map(connector => {
                    return {
                      text: emoji.emojify(connector.text),
                      callback_data: connector.callback_data,
                    };
                  })
                 );
  }

  const opts = {
    reply_to_message_id: msg.message_id,
    reply_markup: JSON.stringify({
      inline_keyboard: keyboard
    })
  };
  telegram_bot.sendMessage(msg.chat.id, 'broadcast', opts);
});

call_connector = (connector, text) => {

  switch(connector.broadcast_method) {
    case 'multi':
      connector.connector_actions.forEach( action => {
        const conn = config.connectors.find(conn => {
          return conn.callback_data == action;
        });
        call_connector(conn, text);
      });
      break;
    case 'telegram':
      telegram_bot.sendMessage(connector.chat_id, text);
      break;
    case 'slack':
      const slack = new Slack(connector.web_hook);
      slack.send({
        text: text,
        channel: connector.channel,
        username: connector.bot_name
      });
      break;
    case 'discord':
      const discord_bot = new Discord.Client({
        token: connector.token,
        autorun: true
      });

      discord_bot.on('ready', function() {
        discord_bot.sendMessage({
          to: connector.channel_id,
          message: text,
        });
      });
      break;
    case 'twitter':
      var twitter = new Twitter({
        consumer_key:         connector.twitter_config.consumer_key,
        consumer_secret:      connector.twitter_config.consumer_secret,
        access_token:         connector.twitter_config.access_token,
        access_token_secret:  connector.twitter_config.access_token_secret,
      })
      twitter.post('statuses/update', { status: text });
      break;
  }

};

telegram_bot.on('callback_query', function onCallbackQuery(callbackQuery) {
  const action = callbackQuery.data;
  const msg = callbackQuery.message;
  const text = msg.reply_to_message.text;
  let json_content = {};
  let output_content = {};

  if(config.exports && config.exports.broadcast && config.exports.broadcast.length > 0) {

    config.exports.broadcast.forEach( output => {

      switch(output.method) {
        case 'json':

          if(fs.existsSync(output.path)) {
            json_content = JSON.parse(fs.readFileSync(output.path, 'utf8'));
          }

          if(!json_content.items)
            json_content.items = [];

          let item = json_content.items.find( item => {
            return item.text == text;
          });

          if(item) {
            item.actions.push({action: action, timestamp: moment().unix()});
          } else {

            const parsedUrl = url_regex.exec(text);
            let url = null;
            if(parsedUrl && parsedUrl.length > 0)
              url = parsedUrl[0];

            json_content.items.push({
              url: url,
              text: text,
              actions: [{action: action, timestamp: moment().unix()}]
            });
          }

          fs.writeFileSync(output.path, JSON.stringify(json_content, null, 4));
          break;

        case 'csv':
          output_content = moment().unix() + ',' + action + ',' + text.replace(/(\r\n|\n|\r)/gm, ' ') + '\n';
          fs.appendFileSync(output.path, output_content);
          break;

        case 'feed':

          let feed = new Feed({
            title: 'BotCast',
            description: 'url streaming',
            id: 'http://botcast.alexgirard.com/',
            link: 'http://botcast.alexgirard.com/',
            image: 'http://botcast.alexgirard.com/image.jpg',
            copyright: 'All rights reserved 2017, Alexandre Girard',
            updated: moment().toDate(),
            generator: 'botcast',
            feedLinks: {
              json: 'https://botcast.alexgirard.com/feed.json',
              atom: 'https://botcast.alexgirard.com/atom.xml',
            },
            author: {
              name: 'Alexandre Girard',
              email: 'botcast@alexgirard.com',
              link: 'https://alexgirard.com'
            }
          })

          if(fs.existsSync(output.data)) {
            json_content = JSON.parse(fs.readFileSync(output.data, 'utf8'));
          }


          if(!json_content.items)
            json_content.items = [];

          let feed_items = json_content.items.filter( item => {
            return item.url && item.url.length > 0 && typeof(item.actions) != 'undefined';
          }).sort( (b, a) => {
            return a.actions[0].timestamp - b.actions[0].timestamp;
          });

          if(output.action_filters && output.action_filters.length > 0) {

            feed_items = feed_items.filter( item => {
              return item.actions.map(action => action.action).some(action => {
                return output.action_filters.indexOf(action) >= 0;
              });
            });
          }

          if(output.limit && output.limit > 0) {
            feed_items = feed_items.slice(0, output.limit);
          }

          feed_items.forEach((item, index) => {
            feed.addItem({
              title: item.text,
              id: item.url,
              link: item.url,
              description: item.text,
              content: item.text,
              date: moment.unix(item.actions[0].timestamp).toDate(),
              tags: item.actions.map( action => action.action )
            })
          });


          switch(output.format) {
            case 'json':
              output_content = feed.json1();
              break;
            case 'atom':
              output_content = feed.atom1();
              break;
          }

          fs.writeFileSync(output.path, output_content);
          break;

        case 'network_json':

          let network = {};
          if(fs.existsSync(output.path)) {
            network = JSON.parse(fs.readFileSync(output.path, 'utf8'));
          }

          if(!network.nodes)
            network.nodes = [];

          let text_node = network.nodes.find(node => node.label == text);

          if(!text_node) {
            text_node = {
              id: network.nodes.length,
              label: text,
              size: 1,
              x: Math.random(),
              y: Math.random(),
              metadata: {
                category: 'text',
                actions: [{type: action, timestamp: moment().unix()}],
              }
            };
            network.nodes.push(text_node)
          } else {
            text_node.metadata.actions.push({type: action, timestamp: moment().unix()});
          }

          let broadcast_node = network.nodes.find(node => node.label == action);

          if(!broadcast_node) {
            broadcast_node = {
              id: network.nodes.length,
              label: action,
              x: Math.random(),
              y: Math.random(),
              size: 1,
              metadata: {
                category: 'action',
                actions: [{type: action, timestamp: moment().unix()}],
              }
            };
            network.nodes.push(broadcast_node)
          } else {
            broadcast_node.metadata.actions.push({type: action, timestamp: moment().unix()});
          }

          if(!network.edges)
            network.edges = [];

          let text_broadcast_edge = network.edges.find( edge => {
            return edge.source == text_node.id && edge.target == broadcast_node.id;
          });

          if(!text_broadcast_edge) {
            text_broadcast_edge = {
              id: network.edges.length,
              source: text_node.id,
              target: broadcast_node.id,
              timestamps: [moment().unix()],
            };
            network.edges.push(text_broadcast_edge);
          } else {
            text_broadcast_edge.timestamps.push(moment().unix());
          }

          fs.writeFileSync(output.path, JSON.stringify(network, null, 2));
          break;
      };

    });

  }

  const connector = config.connectors.find(connector => {
    return connector.callback_data == action;
  });

  call_connector(connector, text);

  telegram_bot.answerCallbackQuery(callbackQuery.id);

});
