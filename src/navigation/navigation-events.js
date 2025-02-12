import { reroute } from './reroute.js';
import { find } from '../utils/find.js';

/* We capture navigation event listeners so that we can make sure
 * that application navigation listeners are not called until
 * single-spa has ensured that the correct applications are
 * unmounted and mounted.
 */
const capturedEventListeners = {
  hashchange: [],
  popstate: [],
};

export const routingEventsListeningTo = ['hashchange', 'popstate'];

export function navigateToUrl(obj, opts={}) {
  let url;
  if (typeof obj === 'string') {
    url = obj ;
  } else if (this && this.href) {
    url = this.href;
  } else if (obj && obj.currentTarget && obj.currentTarget.href && obj.preventDefault) {
    url = obj.currentTarget.href;
    obj.preventDefault();
  } else {
    throw Error(`singleSpaNavigate must be either called with a string url, with an <a> tag as its context, or with an event whose currentTarget is an <a> tag`);
  }

  const current = parseUri(window.location.href);
  const destination = parseUri(url);

  if (url.indexOf('#') === 0) {
    window.location.hash = '#' + destination.anchor;
  } else if (current.host !== destination.host && destination.host) {
    if (opts.isTestingEnv) {
      return {wouldHaveReloadedThePage: true};
    } else {
      window.location.href = url;
    }
  } else if (!isSamePath(destination.path + "?" + destination.query, current.path + "?" + current.query)) {
    // different path, host, or query params
    window.history.pushState(null, null, url);
  } else {
    window.location.hash = '#' + destination.anchor;
  }
  console.log('navigatorToUrl',destination);
  function isSamePath(destination, current) {
    // if the destination has a path but no domain, it doesn't include the root '/'
    return current === destination || current === '/' + destination;
  }
}

//捕捉dom事件，由于single spa的异步加载模块，因此路由这些切换的时候，需要将事件都先暂存下等待异步模块加载完成，随后进行路由的切换
export function callCapturedEventListeners(eventArguments) {
  console.log('call all event',eventArguments)
  if (eventArguments) {
    const eventType = eventArguments[0].type;
    if (routingEventsListeningTo.indexOf(eventType) >= 0) {
      //适配hashchange popstate
      capturedEventListeners[eventType].forEach(listener => {
        listener.apply(this, eventArguments);
      });
    }
  }
}

function urlReroute() {
  //navigator reroute
  console.log('navigator url reroute',arguments);
  reroute([], arguments)
}


// We will trigger an app change for any routing events.
window.addEventListener('hashchange', urlReroute);
window.addEventListener('popstate', urlReroute);

// Monkeypatch addEventListener so that we can ensure correct timing
const originalAddEventListener = window.addEventListener;
const originalRemoveEventListener = window.removeEventListener;
window.addEventListener = function(eventName, fn) {
  this.console.log('全新事件添加了',eventName)
  if (typeof fn === 'function') {
    if (routingEventsListeningTo.indexOf(eventName) >= 0 && !find(capturedEventListeners[eventName], listener => listener === fn)) {
      capturedEventListeners[eventName].push(fn);
      return;
    }
  }
  //相当于劫持了原生添加事件监听的方法
  return originalAddEventListener.apply(this, arguments);
}

window.removeEventListener = function(eventName, listenerFn) {
  this.console.log('全新事件移除了',eventName)
  if (typeof listenerFn === 'function') {
    if (routingEventsListeningTo.indexOf(eventName) >= 0) {
      capturedEventListeners[eventName] = capturedEventListeners[eventName].filter(fn => fn !== listenerFn);
      return;
    }
  }

  return originalRemoveEventListener.apply(this, arguments);
}

const originalPushState = window.history.pushState;
window.history.pushState = function(state) {
  const result = originalPushState.apply(this, arguments);

  urlReroute(createPopStateEvent(state));
  
  return result;
}

const originalReplaceState = window.history.replaceState;
window.history.replaceState = function(state) {
  const result = originalReplaceState.apply(this, arguments);
  urlReroute(createPopStateEvent(state));
  return result;
}

function createPopStateEvent(state) {
  // https://github.com/CanopyTax/single-spa/issues/224 and https://github.com/CanopyTax/single-spa-angular/issues/49
  // We need a popstate event even though the browser doesn't do one by default when you call replaceState, so that
  // all the applications can reroute.
  try {
    return new PopStateEvent('popstate', {state});
  } catch (err) {
    // IE 11 compatibility https://github.com/CanopyTax/single-spa/issues/299
    // https://docs.microsoft.com/en-us/openspecs/ie_standards/ms-html5e/bd560f47-b349-4d2c-baa8-f1560fb489dd
    const evt = document.createEvent('PopStateEvent');
    evt.initPopStateEvent('popstate', false, false, state);
    return evt;
  }
}

/* For convenience（方便） in `onclick` attributes, we expose（暴露） a global function for navigating to
 * whatever an <a> tag's href is.
 */
window.singleSpaNavigate = navigateToUrl;

function parseUri(str) {
  // parseUri 1.2.2
  // (c) Steven Levithan <stevenlevithan.com>
  // MIT License
  // http://blog.stevenlevithan.com/archives/parseuri
  const parseOptions = {
    strictMode: true,
    key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"],
    q:   {
      name:   "queryKey",
      parser: /(?:^|&)([^&=]*)=?([^&]*)/g
    },
    parser: {
      strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
      loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
    }
  };

  let  o = parseOptions;
  let m = o.parser[o.strictMode ? "strict" : "loose"].exec(str);
  let uri = {};
  let i = 14;

  while (i--) uri[o.key[i]] = m[i] || "";

  uri[o.q.name] = {};
  uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
    if ($1) uri[o.q.name][$1] = $2;
  });

  return uri;
}
