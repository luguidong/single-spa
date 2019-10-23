import CustomEvent from 'custom-event';
import { isStarted } from '../start.js';
import { toLoadPromise } from '../lifecycles/load.js';
import { toBootstrapPromise } from '../lifecycles/bootstrap.js';
import { toMountPromise } from '../lifecycles/mount.js';
import { toUnmountPromise } from '../lifecycles/unmount.js';
import { getMountedApps, getAppsToLoad, getAppsToUnmount, getAppsToMount } from '../applications/apps.js';
import { callCapturedEventListeners } from './navigation-events.js';
import { getAppsToUnload, toUnloadPromise } from '../lifecycles/unload.js';

let appChangeUnderway = false, peopleWaitingOnAppChange = [];

export function triggerAppChange() {
  // Call reroute with no arguments, intentionally
  return reroute()
}

export function reroute(pendingPromises = [], eventArguments) {
  if (appChangeUnderway) {
    return new Promise((resolve, reject) => {
      peopleWaitingOnAppChange.push({
        resolve,
        reject,
        eventArguments,
      });
    });
  }

  appChangeUnderway = true;
  let wasNoOp = true;
  //前期注册app时，这里是false，注册完成后，这里变为true，
  if (isStarted()) {
    return performAppChanges();
  } else {
    return loadApps();
  }
  //这里应该就是，加载其它模块的部分，并返回一个promise.all加载所有过滤后的资源，并执行finishUpAndReturn
  function loadApps() {
    return Promise.resolve().then(() => {
      //每次注册资源地址都会在这执行一次，通过app.js的getAppsToLoad拿到资源地址，并进行过滤
      const loadPromises = getAppsToLoad().map(toLoadPromise);

      if (loadPromises.length > 0) {
        wasNoOp = false;
      }
      console.log('对每一个app进行加载');
      console.log(loadPromises);
      return Promise
        .all(loadPromises)
        .then(finishUpAndReturn)
        .catch(err => {
          callAllEventListeners();
          throw err;
        })
    })
  }

  function performAppChanges() {
    return Promise.resolve().then(() => {
      //注册single-spa:before-routing-event自定义事件
      window.dispatchEvent(new CustomEvent("single-spa:before-routing-event", getCustomEventDetail()));
      const unloadPromises = getAppsToUnload().map(toUnloadPromise);
      console.log('perform unload',unloadPromises)
      const unmountUnloadPromises = getAppsToUnmount()
        .map(toUnmountPromise)
        .map(unmountPromise => unmountPromise.then(toUnloadPromise));
      
      const allUnmountPromises = unmountUnloadPromises.concat(unloadPromises);
      if (allUnmountPromises.length > 0) {
        wasNoOp = false;
      }

      const unmountAllPromise = Promise.all(allUnmountPromises);
      console.log('perform unmount',unmountAllPromise)
      const appsToLoad = getAppsToLoad();

      /* We load and bootstrap apps while other apps are unmounting, but we
       * wait to mount the app until all apps are finishing unmounting
       */
      const loadThenMountPromises = appsToLoad.map(app => {
        return toLoadPromise(app)
          .then(toBootstrapPromise)
          .then(app => {
            return unmountAllPromise
              .then(() => toMountPromise(app))
          })
      })
      console.log('perform mount',loadThenMountPromises)
      if (loadThenMountPromises.length > 0) {
        wasNoOp = false;
      }

      /* These are the apps that are already bootstrapped and just need
       * to be mounted. They each wait for all unmounting apps to finish up
       * before they mount.
       */
      //对app进行过滤，推测是拿到mount的app，通过console能够看到每次点到哪个模块，这里获取的就是哪个模块
      const mountPromises = getAppsToMount()
        .filter(appToMount => appsToLoad.indexOf(appToMount) < 0)
        .map(appToMount => {
          return toBootstrapPromise(appToMount)
            .then(() => unmountAllPromise)
            .then(() => toMountPromise(appToMount))
        })
      if (mountPromises.length > 0) {
        wasNoOp = false;
      }
      console.log('perform mountPromise',mountPromises)
      return unmountAllPromise
        .catch(err => {
          callAllEventListeners();
          throw err;
        })
        .then(() => {
          /* Now that the apps that needed to be unmounted are unmounted, their DOM navigation
           * events (like hashchange or popstate) should have been cleaned up. So it's safe
           * to let the remaining captured event listeners to handle about the DOM event.
           */
          //重置事件和路由监听
          callAllEventListeners();

          return Promise
            .all(loadThenMountPromises.concat(mountPromises))
            .catch(err => {
              pendingPromises.forEach(promise => promise.reject(err));
              throw err;
            })
            .then(() => finishUpAndReturn(false))
        })

    })
  }
  //加载完模块后需要进行更新
  function finishUpAndReturn(callEventListeners=true) {
    //returnValue拿到的只是已经mounted的app的name
    const returnValue = getMountedApps();

    if (callEventListeners) {
      callAllEventListeners();
    }
    pendingPromises.forEach(promise => promise.resolve(returnValue));

    try {
      const appChangeEventName = wasNoOp ? "single-spa:no-app-change": "single-spa:app-change";
      //custom-event，基于浏览器的customEvent，兼容了ie8
      window.dispatchEvent(new CustomEvent(appChangeEventName, getCustomEventDetail()));
      window.dispatchEvent(new CustomEvent("single-spa:routing-event", getCustomEventDetail()));
    } catch (err) {
      /* We use a setTimeout because if someone else's event handler throws an error, single-spa
       * needs to carry on. If a listener to the event throws an error, it's their own fault, not
       * single-spa's.
       */
      setTimeout(() => {
        throw err;
      });
    }

    /* Setting this allows for subsequent(后来的) calls to reroute() to actually perform
     * a reroute instead of just getting queued behind the current reroute call.
     * We want to do this after the mounting/unmounting is done but before we
     * resolve the promise for the `reroute` function.
     */
    appChangeUnderway = false;

    if (peopleWaitingOnAppChange.length > 0) {
      /* While we were rerouting, someone else triggered another reroute that got queued.
       * So we need reroute again.
       */
      const nextPendingPromises = peopleWaitingOnAppChange;
      peopleWaitingOnAppChange = [];
      reroute(nextPendingPromises);
    }

    return returnValue;
  }
  //我们需要调用所有被延迟的事件监听器，因为它们正在等待single-spa,这包括当前运行的performAppChanges()的haschange和popstate事件，以及所有排队的事件监听器，
  //我们希望以相同的顺序调用监听器，就像它们没有被single-spa延迟一样,这意味着先排队，然后是最近的一个
  /* We need to call all event listeners that have been delayed because they were
   * waiting on single-spa. This includes haschange and popstate events for both
   * the current run of performAppChanges(), but also all of the queued event listeners.
   * We want to call the listeners in the same order as if they had not been delayed by
   * single-spa, which means queued ones first and then the most recent one.
   */
  function callAllEventListeners() {
    pendingPromises.forEach(pendingPromise => {
      callCapturedEventListeners(pendingPromise.eventArguments);
    });

    callCapturedEventListeners(eventArguments);
  }
  //对自定义事件配置的简单封装
  function getCustomEventDetail() {
    const result = {detail: {}}

    if (eventArguments && eventArguments[0]) {
      result.detail.originalEvent = eventArguments[0]
    }

    return result
  }
}
