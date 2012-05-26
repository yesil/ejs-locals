var ejs = require('ejs')
  , path = require('path')
  , exists = path.existsSync
  , resolve = path.resolve
  , extname = path.extname
  , dirname = path.dirname
  , join = path.join
  , basename = path.basename
  , fs = require('fs');

/**
 * Express 3.x Layout & Partial support for EJS.
 *
 * The `partial` feature from Express 2.x is back as a template engine,
 * along with support for `layout`, `include` and `block/script/stylesheet`.
 *
 *
 * Example index.ejs:
 *
 *   <% layout('boilerplate') %>
 *   <h1>I am the <%=what%> template</h1>
 *   <% script('foo.js') %>
 *
 *
 * Example boilerplate.ejs:
 *
 *   <html>
 *     <head>
 *       <title>It's <%=who%></title>
 *       <%-scripts%>
 *     </head>
 *     <body><%-body%></body>
 *   </html>
 *
 *
 * Sample app:
 *
 *    var express = require('express')
 *      , app = express();
 *
 *    // use ejs-locals for all ejs templates:
 *    app.engine('ejs', require('ejs-locals'));
 *
 *    // render 'index' into 'boilerplate':
 *    app.get('/',function(req,res,next){
 *      res.render('index', { what: 'best', who: 'me' });
 *    });
 *
 *    app.listen(3000);
 *
 * Example output for GET /:
 *
 *   <html>
 *     <head>
 *       <title>It's me</title>
 *       <script src="foo.js"></script>
 *     </head>
 *     <body><h1>I am the best template</h1></body>
 *   </html>
 *
 */

var renderFile = module.exports = function(path, options, fn){

  if (!options.locals.blocks) {
    // one set of blocks no matter how often we recurse
    var blocks = { scripts: new Block(), stylesheets: new Block() };
    options.locals.blocks = blocks;
    options.locals.scripts = blocks.scripts;
    options.locals.stylesheets = blocks.stylesheets;
    options.locals.block = block.bind(blocks);
    options.locals.stylesheet = stylesheet.bind(blocks.stylesheets);
    options.locals.script = script.bind(blocks.scripts);
  }
  // override locals for layout/include/partial bound to current options
  options.locals.layout  = layout.bind(options);
  options.locals.include = include.bind(options);
  options.locals.partial = partial.bind(options);

  ejs.renderFile(path, options, function(err, html) {

    var layout = options.locals._layoutFile
    if (layout) {

      // clear to make sure we don't recurse forever (layouts can be nested)
      delete options.locals._layoutFile;
      // make sure caching works inside ejs.renderFile/render
      delete options.filename;

      // find layout path relative to current template, then
      // recurse and use this layout as `body` in the parent
      options.locals.body = html;
      renderFile(join(dirname(path), layout), options, fn);
    } else {
      // no layout, just do the default:
      fn(null, html);
    }
  });

};

/**
 * Memory cache for resolved object names.
 */

var cache = {};

/**
 * Resolve partial object name from the view path.
 *
 * Examples:
 *
 *   "user.ejs" becomes "user"
 *   "forum thread.ejs" becomes "forumThread"
 *   "forum/thread/post.ejs" becomes "post"
 *   "blog-post.ejs" becomes "blogPost"
 *
 * @return {String}
 * @api private
 */

function resolveObjectName(view){
  return cache[view] || (cache[view] = view
    .split('/')
    .slice(-1)[0]
    .split('.')[0]
    .replace(/^_/, '')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .split(/ +/).map(function(word, i){
      return i
        ? word[0].toUpperCase() + word.substr(1)
        : word;
    }).join(''));
};

/**
 * Lookup:
 *
 *   - partial `_<name>`
 *   - any `<name>/index`
 *   - non-layout `../<name>/index`
 *   - any `<root>/<name>`
 *   - partial `<root>/_<name>`
 *
 * Options:
 *
 *   - `cache` store the resolved path for the view, to avoid disk I/O
 *
 * @param {String} room, base path for searching for templates
 * @param {String} view, name of the partial to lookup (without path)
 * @param {String} ext, type of template to find, with '.'
 * @param {Object} options, for `options.cache` behavior
 * @return {String}
 * @api private
 */

function lookup(root, view, ext, options){
  var name = resolveObjectName(view)
    , key = [ root, view, ext ].join('-');

  if (options.cache && cache[key]) return cache[key];

  // Try _ prefix ex: ./views/_<name>.jade
  // taking precedence over the direct path
  view = resolve(root,'_'+name+ext)
  if( exists(view) ) return options.cache ? cache[key] = view : view;

  // Try index ex: ./views/user/index.jade
  view = resolve(root,name,'index'+ext);
  if( exists(view) ) return options.cache ? cache[key] = view : view;

  // Try ../<name>/index ex: ../user/index.jade
  // when calling partial('user') within the same dir
  view = resolve(root,'..',name,'index'+ext);
  if( exists(view) ) return options.cache ? cache[key] = view : view;

  // Try root ex: <root>/user.jade
  view = resolve(root,name+ext);
  if( exists(view) ) return options.cache ? cache[key] = view : view;

  return null;
};


/**
 * Render `view` partial with the given `options`. Optionally a
 * callback `fn(err, str)` may be passed instead of writing to
 * the socket.
 *
 * Options:
 *
 *   - `object` Single object with name derived from the view (unless `as` is present)
 *
 *   - `as` Variable name for each `collection` value, defaults to the view name.
 *     * as: 'something' will add the `something` local variable
 *     * as: this will use the collection value as the template context
 *     * as: global will merge the collection value's properties with `locals`
 *
 *   - `collection` Array of objects, the name is derived from the view name itself.
 *     For example _video.html_ will have a object _video_ available to it.
 *
 * @param  {String} view
 * @param  {Object|Array} options, collection or object
 * @return {String}
 * @api private
 */

function partial(view, options){

  var collection
    , object
    , locals
    , name;

  // parse options
  if( options ){
    // collection
    if( options.collection ){
      collection = options.collection;
      delete options.collection;
    } else if( 'length' in options ){
      collection = options;
      options = {};
    }

    // locals
    if( options.locals ){
      locals = options.locals;
      delete options.locals;
    }

    // object
    if( 'Object' != options.constructor.name ){
      object = options;
      options = {};
    } else if( options.object != undefined ){
      object = options.object;
      delete options.object;
    }
  } else {
    options = {};
  }

  // merge locals into options
  if( locals )
    options.__proto__ = locals;

  // merge app locals into options
  for(var k in this)
    options[k] = options[k] || this[k];

  // extract object name from view
  name = options.as || resolveObjectName(view);

  // find view, relative to this filename
  // (FIXME: filename is set by ejs engine, other engines may need more help)
  var root = dirname(options.filename)
    , ext = extname(view) || '.ejs' // FIXME: how to reach 'view engine' from here?
    , file = lookup(root, view, ext, options)
    , key = file + ':string';

  // read view
  var source = options.cache
    ? cache[key] || (cache[key] = fs.readFileSync(file, 'utf8'))
    : fs.readFileSync(file, 'utf8');

  options.filename = file;

  // render partial
  function render(){
    if (object) {
      if ('string' == typeof name) {
        options[name] = object;
      } else if (name === global) {
        // wtf?
        // merge(options, object);
      }
    }
    // TODO Support other templates (but it's sync now...)
    return ejs.render(source, options);
  }

  // Collection support
  if (collection) {
    var len = collection.length
      , buf = ''
      , keys
      , key
      , val;

    if ('number' == typeof len || Array.isArray(collection)) {
      options.collectionLength = len;
      for (var i = 0; i < len; ++i) {
        val = collection[i];
        options.firstInCollection = i == 0;
        options.indexInCollection = i;
        options.lastInCollection = i == len - 1;
        object = val;
        buf += render();
      }
    } else {
      keys = Object.keys(collection);
      len = keys.length;
      options.collectionLength = len;
      options.collectionKeys = keys;
      for (var i = 0; i < len; ++i) {
        key = keys[i];
        val = collection[key];
        options.keyInCollection = key;
        options.firstInCollection = i == 0;
        options.indexInCollection = i;
        options.lastInCollection = i == len - 1;
        object = val;
        buf += render();
      }
    }

    return buf;
  } else {
    return render();
  }
}

/**
 * Apply the given `view` as the layout for the current template,
 * using the current options/locals. The current template will be
 * supplied to the given `view` as `body`, along with any `blocks`
 * added by child templates.
 *
 * `options` are bound  to `this` in renderFile, you just call
 * `include('myview')`
 *
 * @param  {String} view
 * @api private
 */
function layout(view){
  if (view === true) {
    // default layout
    view = 'layout.ejs';
  }
  if (extname(view) != '.ejs') {
    // default extension
    // FIXME: how to reach 'view engine' from here?
    view += '.ejs'
  }
  this.locals._layoutFile = view;
}

/**
 * Apply the current `options` to the given `view` to be included
 * in the current template at call time.
 *
 * `options` are bound in renderFile, you just call `include('myview')`
 *
 * @param  {String} view
 * @api private
 */
function include(view) {

  // find view, relative to this filename (this == original options)
  // (FIXME: options.filename is set by ejs engine, other engines may need more help)
  var root = dirname(this.filename)
    , ext = extname(view)
    , file = join(root, view + (ext ? '' : '.ejs'))
    , key = file + ':string';

  // read view
  var source = this.cache
    ? cache[key] || (cache[key] = fs.readFileSync(file, 'utf8'))
    : fs.readFileSync(file, 'utf8');

  this.filename = file;

  // TODO Support other templates (but it's sync now...)
  return ejs.render(source, this);
}

function Block() {
  this.html = [];
}

Block.prototype = {
  toString: function() {
    return this.html.join('\n');
  },
  append: function(more) {
    this.html.push(more);
  },
  prepend: function(more) {
    this.html.unshift(more);
  },
  replace: function(instead) {
    this.html = [ instead ];
  }
};

/**
 * Return the block with the given name, create it if necessary.
 * Optionally append the given html to the block.
 *
 * The returned Block can append, prepend or replace the block,
 * as well as render it when included in a parent template.
 *
 * @param  {String} name
 * @param  {String} html
 * @return {Block}
 * @api private
 */
function block(name, html) {
  // bound to the blocks object in renderFile
  var blk = this[name];
  if (!blk) {
    // always create, so if we request a
    // non-existent block we'll get a new one
    blk = this[name] = new Block();
  }
  if (html) {
    blk.append(html);
  }
  return blk;
}

// bound to scripts Block in renderFile
function script(path, type) {
  if (path) {
    this.append('<script src="'+path+'"'+(type ? 'type="'+type+'"' : '')+'></script>');
  }
  return this;
}

// bound to stylesheets Block in renderFile
function stylesheet(path, media) {
  if (path) {
    this.append('<link rel="stylesheet" href="'+path+'"'+(media ? 'media="'+media+'"' : '')+' />');
  }
  return this;
}

