'use strict';

var acceptLanguageParser = require('accept-language-parser');
var Cache = require('nice-cache');
var Client = require('../../client');
var format = require('stringformat');
var fs = require('fs-extra');
var packageInfo = require('../../package.json');
var path = require('path');
var Repository = require('../domain/repository');
var RequireWrapper = require('../domain/require-wrapper');
var sanitiser = require('../domain/sanitiser');
var Targz = require('tar.gz');
var url = require('url');
var urlBuilder = require('../domain/url-builder');
var validator = require('../domain/validator');
var versionHandler = require('../domain/version-handler');
var vm = require('vm');
var _ = require('underscore');

var repository, 
    targz,
    client,
    cache;

exports.init = function(conf){
  repository = new Repository(conf);
  targz = new Targz();
  client = new Client(conf);
  cache = new Cache();
};

exports.index = function(req, res){

  repository.getComponents(function(err, components){
    if(err){
      res.errorDetails = 'cdn not available';
      return res.json(404, { error: res.errorDetails });
    }

    res.json(200, {
      href: res.conf.baseUrl,
      components: _.map(components, function(component){
        return urlBuilder.component(component, res.conf.baseUrl);
      }),
      type: res.conf.local ? 'oc-registry-local' : 'oc-registry',
      ocVersion: packageInfo.version
    });
  });
};

exports.componentInfo = function(req, res){

  repository.getComponent(req.params.componentName, req.params.componentVersion, function(err, component){

    if(err){
      res.errorDetails = err;
      return res.json(404, { err: err });
    }

    res.json(200, _.extend(component, {
      requestVersion: req.params.componentVersion || ''
    }));
  });

};

exports.component = function(req, res){

  var requestedComponent = {
    name: req.params.componentName,
    version: req.params.componentVersion || '',
    parameters: req.query
  };

  var conf = res.conf;

  repository.getComponent(requestedComponent.name, requestedComponent.version, function(err, component){

    // check route exist for component and version
    if(err){
      res.errorDetails = err;
      return res.json(404, { err: err });
    }

    // sanitise params
    var params = sanitiser.sanitiseComponentParameters(requestedComponent.parameters, component.oc.parameters);

    // check params
    var result = validator.validateComponentParameters(params, component.oc.parameters);

    if(!result.isValid){
      res.errorDetails = result.errors.message;
      return res.json(400, { error: res.errorDetails });
    }

    var returnComponent = function(err, data){
      if(err){
        res.errorDetails = 'component data resolving error';
        return res.json(502, { error: res.errorDetails });
      }

      var componentHref = urlBuilder.component({
        name: component.name,
        version: requestedComponent.version,
        parameters: params
      }, res.conf.baseUrl);

      var response = {
        href: componentHref,
        type: res.conf.local ? 'oc-component-local' : 'oc-component',
        version: component.version,
        requestVersion: requestedComponent.version
      };
      
      if(req.headers.accept === 'application/vnd.oc.prerendered+json'){
        res.json(200, _.extend(response, {
          data: data,
          template: {
            src: repository.getStaticFilePath(component.name, component.version, 'template.js'),
            type: component.oc.files.template.type,
            key: component.oc.files.template.hashKey
          },
          renderMode: 'pre-rendered'
        }));        
      } else {

        var cacheKey = format('{0}/{1}/template.js', component.name, component.version),
            cached = cache.get('file-contents', cacheKey),
            key = component.oc.files.template.hashKey,
            options = {
              href: componentHref,
              key: key,
              version: component.version,
              templateType: component.oc.files.template.type
            };

        var returnResult = function(template){
          client.renderTemplate(template, data, options, function(err, html){
            res.json(200, _.extend(response, { 
              html: html, 
              renderMode: 'rendered'
            }));
          });
        };

        if(!!cached && !res.conf.local){
          returnResult(cached);
        } else {
          repository.getCompiledView(component.name, component.version, function(err, templateText){
            var context = { jade: require('jade/runtime.js')};
            vm.runInNewContext(templateText, context);
            var template = context.oc.components[key];
            cache.set('file-contents', cacheKey, template);
            returnResult(template);
          });
        }
      }
    };

    if(!component.oc.files.dataProvider){
      returnComponent(null, {});
    } else {

      var cacheKey = format('{0}/{1}/server.js', component.name, component.version),
          cached = cache.get('file-contents', cacheKey),
          reqObj = { 
            acceptLanguage: acceptLanguageParser.parse(req.headers['accept-language']),
            baseUrl: conf.baseUrl,
            env: conf.env,
            params: params,
            staticPath: repository.getStaticFilePath(component.name, component.version, '').replace('https:', '')
          };

      if(!!cached && !res.conf.local){
        cached(reqObj, returnComponent);
      } else {
        repository.getDataProvider(component.name, component.version, function(err, dataProcessorJs){
          if(err){
            res.errorDetails = 'component resolving error';
            return res.json(502, { error: res.errorDetails });
          }

          var context = { 
            require: new RequireWrapper(res.injectedDependencies), 
            module: { 
              exports: {}
            },
            console: res.conf.local ? console : { log: _.noop }
          };

          vm.runInNewContext(dataProcessorJs, context);
          var processData = context.module.exports.data;
          cache.set('file-contents', cacheKey, processData);        
          processData(reqObj, returnComponent);
        });
      }
    }
  });
};

exports.staticRedirector = function(req, res){

  var filePath,
      clientPath = (!!res.conf.prefix ? res.conf.prefix : '/') + 'oc-client/client.js';

  if(req.route.path === clientPath){
    if(res.conf.local){
      filePath = path.join(__dirname, '../../components/oc-client/_package/src/oc-client.min.js');
    } else {
      return res.redirect(repository.getStaticClientPath());
    }
  } else if(req.params.componentName === 'oc-client'){
    filePath = path.join(__dirname, '../../components/oc-client/_package/' + req.params[0]);
  } else {
    filePath = path.join(res.conf.path, req.params.componentName) + '/_package/' + req.params[0];
  }

  if(!fs.existsSync(filePath)){
    res.errorDetails = format('File {0} not found', filePath);
    return res.json(404, { err: res.errorDetails });
  }

  var fileStream = fs.createReadStream(filePath);

  fileStream.on('open', function(){
    fileStream.pipe(res);
  });
};

exports.publish = function(req, res){

  if(!req.params.componentName || !req.params.componentVersion){
    res.errorDetails = 'malformed request';
    return res.json(409, { error: res.errorDetails });
  }

  if(!validator.validateVersion(req.params.componentVersion).isValid){
    res.errorDetails = 'not a valid version';
    return res.json(409, { error: res.errorDetails });
  }
  
  if(!validator.validatePackage(req.files).isValid){
    res.errorDetails = 'package is not valid';
    return res.json(409, { error: res.errorDetails });
  }

  var files = req.files,
      packageFile = files[_.keys(files)[0]],
      packagePath = path.resolve(packageFile.path),
      packageUntarOutput = path.resolve(packageFile.path, '..', packageFile.name.replace('.tar.gz', '')),
      packageOutput = path.resolve(packageUntarOutput, '_package');

  targz.extract(packagePath, packageUntarOutput, function(err){

    if(!!err){
      res.errorDetails = format('Package file is not valid: {0}', err);
      return res.json(500, { error: 'package file is not valid', details: err });
    }

    repository.publishComponent(packageOutput, req.params.componentName, req.params.componentVersion, function(err, result){
      
      if(err){
        if(err.code === 'not_allowed'){
          res.errorDetails = format('Publish not allowed: {0}', err.msg);
          return res.json(403, { error: err.msg });
        } else if(err.code === 'already_exists'){
          res.errorDetails = format('Component already exists: {0}', err.msg);
          return res.json(403, { error: err.msg });
        } else if(err.code === 'name_not_valid'){
          res.errorDetails = format('Component name not valid: {0}', err.msg);
          return res.json(409, { error: err.msg });
        } else {
          res.errorDetails = format('Publish failed: {0}', err.msg);
          return res.json(500, { error: err.msg });
        }
      }

      res.json(200, { ok: true });
    });
  });
};