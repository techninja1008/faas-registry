const Gateway = require("faaslang").Gateway;
const url = require("url");
const fs = require("fs");
const config = require("./config.json");
const rimraf = require("rimraf");
const mkdirp = require("mkdirp");
const targz = require('targz');
const FunctionParser = require('faaslang').FunctionParser;
const path = require('path');

// === CODE STOLEN SHAMELESSLY FROM https://stackoverflow.com/a/14801711/2555702 ===

/**
 * Removes a module from the cache
 */
function purgeCache(moduleName) {
    // Traverse the cache looking for the files
    // loaded by the specified module name
    searchCache(moduleName, function (mod) {
        delete require.cache[mod.id];
    });

    // Remove cached paths to the module.
    // Thanks to @bentael for pointing this out.
    Object.keys(module.constructor._pathCache).forEach(function(cacheKey) {
        if (cacheKey.indexOf(moduleName)>0) {
            delete module.constructor._pathCache[cacheKey];
        }
    });
};

/**
 * Traverses the cache to search for all the cached
 * files of the specified module name
 */
function searchCache(moduleName, callback) {
    // Resolve the module identified by the specified name
    var mod = require.resolve(moduleName);

    // Check if the module has been resolved and found within
    // the cache
    if (mod && ((mod = require.cache[mod]) !== undefined)) {
        // Recursively go over the results
        (function traverse(mod) {
            // Go over each of the module's children and
            // traverse them
            mod.children.forEach(function (child) {
                traverse(child);
            });

            // Call the specified callback providing the
            // found cached module
            callback(mod);
        }(mod));
    }
};

// === END SO STEAL ===

class MultiTennantGateway extends Gateway {

  constructor(cfg) {
    cfg = cfg || {};
    cfg.name = 'MultiTennantGateway';
    super(cfg);
    
    this.supportedMethods = {'GET': true, 'POST': true, 'PUT': true, 'DELETE': true,
                             'OPTIONS': true};
  }

  formatName(name) {
    return `${this.name}`
  }

  formatRequest(req) {
    return `(${req ? (req._background ? 'bg:' : '') + req._uuid.split('-')[0] : 'GLOBAL'}) ${this.routename(req)}`
  }

  formatMessage(message, logType) {
    return super.formatMessage(message, logType);
  }

  environment(env) {
    Object.keys(env).forEach(key => process.env[key] = env[key]);
    return true;
  }

  createContext(req, definition, params, data) {
    let context = super.createContext(req, definition, params, data);
    context.service = {};
    context.service.name = definition.mt.ns + "/" + definition.mt.service;
    context.service.path = (definition.mt.ns + "/" + definition.mt.service).split('/');
    context.service.version = definition.mt.version;
    //context.service.environment = 'local'; TODO
    context.service.identifier = `${context.service.path.join('.')}[@${context.service.version || context.service.environment}]`;
    context.http.method = definition.mt.method;
    context.http.body = definition.mt.body;
    return context;
  }

  resolve(req, res, buffer, callback) {
    let self = this;
    
    let urlinfo = url.parse(req.url, true);
    let pathname = urlinfo.pathname;
    let segments;
    if(req.headers.host == config.domains.main){
      let match = pathname.match(/^\/(.*[^\/])\/?$/);
      if(match == null){
        return callback({statusCode: 404})
      }
      segments = match[1].split("/");
      if(segments.length < 2){
        return callback({statusCode: 404})
      }
    }else if(req.headers.host.match(new RegExp("^(.*)\\." + config.domains.ns_parent.replace(".", "\\.") + "$"))){
      let match = req.headers.host.match(new RegExp("^(.*)\\." + config.domains.ns_parent.replace(".", "\\.") + "$"));
      if(match == null){
        return callback({statusCode: 404})
      }
      segments = [match[1], pathname.match(/^\/(.*[^\/])\/?$/)[1].split("/")[0]];
    }else{
      return callback({statusCode: 404})
    }
    
    let ns = segments[0];
    let match = segments[1].match(/^([A-Za-z][A-Za-z0-9_\\-]*)@([A-Za-z0-9][A-Za-z0-9_\\-\\.]*)$/);
    if(match == null){
      return callback({statusCode: 404})
    }
    let service = match[1];
    let version = match[2];
    
    function parseDefinitions(){
      let folder = config.data_location + "/" + ns + "/" + service + "/" + version + "/data/";
      
      let fp = new FunctionParser();
      let definitions = fp.load(folder, "functions");
      
      segments.shift(); segments.shift();
      
      let definition;
      try {
        definition = self.findDefinition(definitions, "/" + segments.join("/"));
      } catch (e) {
        e.statusCode = 404;
        return callback(e);
      }
      
      definition.mtroot = config.data_location + "/" + ns + "/" + service + "/" + version + "/data/";
      definition.mt = {
        ns,
        service,
        version,
        method: req.method,
        body: buffer
      };
      
      return callback(null, definition, {}, buffer);
    }
    
    MC.statObject(config.bucket.name, ns + "/" + service + "/" + version + ".tgz", function(err, stat) {
      if (err) {
        console.log("stat failed")
        return callback(err);
      }
      let dateModified = Date.parse(stat.lastModified);
      
      if(!fs.existsSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified") || parseInt(fs.readFileSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified")) < dateModified){
        if(fs.existsSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")){
          rimraf.sync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")
        }
        mkdirp.sync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")
        
        fs.writeFileSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified", dateModified)
        
        MC.fGetObject(config.bucket.name, ns + "/" + service + "/" + version + ".tgz", config.data_location + "/" + ns + "/" + service + "/" + version + "/bundle.tgz", function(errt) {
          if (errt) {
            console.log("Get Object failed")
            return callback(errt);
          }
          targz.decompress({
            src: config.data_location + "/" + ns + "/" + service + "/" + version + "/bundle.tgz",
            dest: config.data_location + "/" + ns + "/" + service + "/" + version + "/data/"
          }, function(errtt){
            if(errtt) {
              console.log("Extract failed")
              rimraf.sync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")
              return callback(errtt);
            } else {
              parseDefinitions();
            }
          });
        })
        return
      }
      
      parseDefinitions();
    })
  }

  end(req, value) {
    this.log(req, value, 'result');
  }
  
  execute(definition, functionArgs, data, callback) {
    let fn;
    try {
      let rpath = require.resolve(path.join(definition.mtroot, definition.pathname));
      purgeCache(path.join(definition.mtroot, definition.pathname)) // Better than before!
      fn = require(rpath);
    } catch (e) {
      e.fatal = true;
      return callback(e);
    }
    if (definition.format.async) {
      fn.apply(null, functionArgs)
        .then(result => callback(null, result))
        .catch(err => callback(err));
    } else {
      fn.apply(null, functionArgs.concat(callback));
    }
  }

}

module.exports = MultiTennantGateway;