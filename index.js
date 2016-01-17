var parser = require("./parser.js");
var freeFormQuery; // todo: refactor this!

// todo: normalization -> node module?

/* this converts a random boolean expression into a normalized form:
 * A∧B∧… ∨ C∧D∧… ∨ …
 * for example: A∧(B∨C) ⇔ (A∧B)∨(A∧C)
 */
function normalize(query) {
  var normalized_query = {
    logical:"or",
    queries:[]
  };
  function normalize_recursive(rem_query) {
    if (!rem_query.logical) {
      return [{
        logical: "and",
        queries: [rem_query]
      }];
    } else if (rem_query.logical === "and") {
      var c1 = normalize_recursive( rem_query.queries[0] );
      var c2 = normalize_recursive( rem_query.queries[1] );
      // return cross product of c1 and c2
      var c = [];
      for (var i=0; i<c1.length; i++)
        for (var j=0; j<c2.length; j++) {
          c.push({
            logical: "and",
            queries: c1[i].queries.concat(c2[j].queries)
          });
        }
      return c;
    } else if (rem_query.logical === "or") {
      var c1 = normalize_recursive( rem_query.queries[0] );
      var c2 = normalize_recursive( rem_query.queries[1] );
      return [].concat(c1,c2);

    } else {
      console.error("unsupported boolean operator: "+rem_query.logical);
    }
  }
  normalized_query.queries = normalize_recursive(query);
  return normalized_query;
}

module.exports = function wizard(search, options) {
  var defaults = {
    comment: true,
    outputMode: "recursive", // "recursive", "geom", "ids", "…" (out *)
    globalBbox: false,
    //freeFormPresets: [], ?
    //todo: more fine grained controll, e.g. to deactivate "in X"
    timeout: 25,
    maxsize: undefined,
    outputFormat: "json", // "json", "xml"
    aroundRadius: 1000
  }
  // todo: document options
  // todo: re-tweak defaults (e.g. globalBbox->true, outputMode->geom)

  for (var k in options) {
    defaults[k] = options[k];
  }
  options = defaults;

  // quote strings that are safe to be used within c-style comments
  // replace any comment-ending sequences in these strings that would break the resulting query
  function quote_comment_str(s) {
    return s.replace(/\*\//g,'[…]').replace(/\n/g,'\\n');
  }

  var parsedQuery;

  try {
    parsedQuery = parser.parse(search);
  } catch(e) {
    console.error("couldn't parse wizard input");
    return false;
  }

  var query_parts = [];
  var bounds_part;

  if (options.comment === true) {
    query_parts.push('/*');
    query_parts.push('This has been generated by the overpass-turbo wizard.');
    query_parts.push('The original search was:');
    query_parts.push('“'+quote_comment_str(search)+'”');
    query_parts.push('*/');
  } else if (typeof options.comment === "string") {
    query_parts.push('/*');
    query_parts.push(options.comment);
    query_parts.push('*/');
    comment = true;
  }
  query_parts.push(
    '[out:'+options.outputFormat+']'+
    '[timeout:'+options.timeout+']'+
    (options.maxsize !== undefined ? '[maxsize:'+options.maxsize+']' : '')+
    (options.globalBbox ? '[bbox:{{bbox}}]' : '')+
  ';');

  switch(parsedQuery.bounds) {
    case "area":
      if (options.comment)
        query_parts.push('// fetch area “'+parsedQuery.area+'” to search in');
      query_parts.push('{{geocodeArea:'+parsedQuery.area+'}}->.searchArea;');
      bounds_part = '(area.searchArea)';
    break;
    case "around":
      if (options.comment)
        query_parts.push('// adjust the search radius (in meters) here');
      query_parts.push('{{radius='+options.aroundRadius+'}}');
      bounds_part = '(around:{{radius}},{{geocodeCoords:'+parsedQuery.area+'}})';
    break;
    case "bbox":
      bounds_part = options.globalBbox ? '' : '({{bbox}})';
    break;
    case "global":
      bounds_part = undefined;
    break;
    default:
      console.error("unknown bounds condition: "+parsedQuery.bounds);
      return false;
    break;
  }

  function get_query_clause(condition) {
    function escRegexp(str) {
      return str.replace(/([()[{*+.$^\\|?])/g, '\\$1');
    }
    function esc(str) {
      if (typeof str !== "string") return;
      // see http://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL#Escaping
      return str.replace(/\\/g,"\\\\").replace(/"/g,"\\\"") // need to escape those
                .replace(/\t/g,"\\t").replace(/\n/g,"\\n"); // also escape newlines an tabs for better readability of the query
    }
    var key = esc(condition.key);
    var val = esc(condition.val);
    // convert substring searches into matching regexp ones
    if (condition.query === "substr") {
      condition.query = "like";
      condition.val={regex:escRegexp(condition.val)};
    }
    // special case for empty values
    // see https://github.com/drolbr/Overpass-API/issues/53
    if (val === '') {
      if (condition.query === "eq") {
        condition.query = "like";
        condition.val={regex:'^$'};
      } else if (condition.query === "neq") {
        condition.query = "notlike";
        condition.val={regex:'^$'};
      }
    }
    // special case for empty keys
    // see https://github.com/drolbr/Overpass-API/issues/53#issuecomment-26325122
    if (key === '') {
      if (condition.query === "key") {
        condition.query = "likelike";
        key='^$';
        condition.val={regex: '.*'};
      } else if (condition.query === "eq") {
        condition.query = "likelike";
        key='^$';
        condition.val={regex: '^'+escRegexp(condition.val)+'$'};
      } else if (condition.query === "like") {
        condition.query = "likelike";
        key='^$';
      }
    }
    // construct the query clause
    switch(condition.query) {
      case "key":
        return '["'+key+'"]';
      case "nokey":
        return '["'+key+'"!~".*"]';
      case "eq":
        return '["'+key+'"="'+val+'"]';
      case "neq":
        return '["'+key+'"!="'+val+'"]';
      case "like":
        return '["'+key+'"~"'+esc(condition.val.regex)+'"'
               +(condition.val.modifier==="i"?',i':'')
               +']';
      case "likelike":
        return '[~"'+key+'"~"'+esc(condition.val.regex)+'"'
               +(condition.val.modifier==="i"?',i':'')
               +']';
      case "notlike":
        return '["'+key+'"!~"'+esc(condition.val.regex)+'"'
               +(condition.val.modifier==="i"?',i':'')
               +']';
      case "meta":
        switch(condition.meta) {
          case "id":
            return '('+val+')';
          case "newer":
            if (condition.val.match(/^-?\d+ ?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)?$/))
              return '(newer:"{{date:'+val+'}}")';
            return '(newer:"'+val+'")';
          case "user":
            return '(user:"'+val+'")';
          case "uid":
            return '(uid:'+val+')';
          default:
            console.error("unknown query type: meta/"+condition.meta);
            return false;
        }
      case "free form":
        // own module, special cased below
      default:
        console.error("unknown query type: "+condition.query);
        return false;
    }
  }
  function get_query_clause_str(condition) {
    function quotes(s) {
      if (s.match(/^[a-zA-Z0-9_]+$/) === null)
        return '"'+s.replace(/"/g,'\\"')+'"';
      return s;
    }
    function quoteRegex(s) {
      if (s.regex.match(/^[a-zA-Z0-9_]+$/) === null || s.modifier)
        return '/'+s.regex.replace(/\//g,'\\/')+'/'+(s.modifier||'');
      return s.regex;
    }
    switch(condition.query) {
      case "key":
        return quote_comment_str(quotes(condition.key)+'=*');
      case "nokey":
        return quote_comment_str(quotes(condition.key)+'!=*');
      case "eq":
        return quote_comment_str(quotes(condition.key)+'='+quotes(condition.val));
      case "neq":
        return quote_comment_str(quotes(condition.key)+'!='+quotes(condition.val));
      case "like":
        return quote_comment_str(quotes(condition.key)+'~'+quoteRegex(condition.val));
      case "likelike":
        return quote_comment_str('~'+quotes(condition.key)+'~'+quoteRegex(condition.val));
      case "notlike":
        return quote_comment_str(quotes(condition.key)+'!~'+quoteRegex(condition.val));
      case "substr":
        return quote_comment_str(quotes(condition.key)+':'+quotes(condition.val));
      case "meta":
        switch(condition.meta) {
          case "id":
            return quote_comment_str('id:'+quotes(condition.val));
          case "newer":
            return quote_comment_str('newer:'+quotes(condition.val));
          case "user":
            return quote_comment_str('user:'+quotes(condition.val));
          case "uid":
            return quote_comment_str('uid:'+quotes(condition.val));
          default:
            return '';
        }
      case "free form":
        return quote_comment_str(quotes(condition.free));
      default:
        return '';
    }
  }

  parsedQuery.query = normalize(parsedQuery.query);

  if (options.comment)
    query_parts.push('// gather results');
  query_parts.push('(');
  for (var i=0; i<parsedQuery.query.queries.length; i++) {
    var and_query = parsedQuery.query.queries[i];

    var types = ['node','way','relation'];
    var clauses = [];
    var clauses_str = [];
    for (var j=0; j<and_query.queries.length; j++) {
      var cond_query = and_query.queries[j];
      // todo: looks like some code duplication here could be reduced by refactoring
      if (cond_query.query === "free form") {
        // eventually load free form query module
        if (!freeFormQuery) freeFormQuery = turbo.ffs.free();
        var ffs_clause = freeFormQuery.get_query_clause(cond_query);
        if (ffs_clause === false)
          return false;
        // restrict possible data types
        types = types.filter(function(t) {
          return ffs_clause.types.indexOf(t) != -1;
        });
        // add clauses
        if (options.comment)
          clauses_str.push(get_query_clause_str(cond_query));
        clauses = clauses.concat(ffs_clause.conditions.map(function(condition) {
          return get_query_clause(condition);
        }));
      } else if (cond_query.query === "type") {
        // restrict possible data types
        types = types.indexOf(cond_query.type) != -1 ? [cond_query.type] : [];
      } else {
        // add another query clause
        if (options.comment)
          clauses_str.push(get_query_clause_str(cond_query));
        var clause = get_query_clause(cond_query);
        if (clause === false) return false;
        clauses.push(clause);
      }
    }
    clauses_str = clauses_str.join(' and ');

    // construct query
    if (options.comment)
      query_parts.push('  // query part for: “'+clauses_str+'”')
    for (var t=0; t<types.length; t++) {
      var buffer = '  '+types[t];
      for (var c=0; c<clauses.length; c++)
        buffer += clauses[c];
      if (bounds_part)
        buffer += bounds_part;
      buffer += ';';
      query_parts.push(buffer);
    }
  }
  query_parts.push(');');

  if (options.comment)
    query_parts.push('// print results');
  if (options.outputMode === "recursive") {
    query_parts.push('out body;');
    query_parts.push('>;');
    query_parts.push('out skel qt;');
  } else {
    query_parts.push('out ' + options.outputMode);
  }

  return query_parts.join('\n');
}
