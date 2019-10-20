import { LOAD_ERROR, NOT_BOOTSTRAPPED, LOADING_SOURCE_CODE, SKIP_BECAUSE_BROKEN, NOT_LOADED } from '../applications/app.helpers.js';
import { ensureValidAppTimeouts } from '../applications/timeouts.js';
import { handleAppError } from '../applications/app-errors.js';
import { flattenFnArray, smellsLikeAPromise, validLifecycleFn } from './lifecycle.helpers.js';
import { getProps } from './prop.helpers.js';

class UserError extends Error {}
//对每一个注册的资源转为一个promise，
export function toLoadPromise(app) {
  return Promise.resolve().then(() => {
    if (app.status !== NOT_LOADED && app.status !== LOAD_ERROR) {
      return app;
    }

    app.status = LOADING_SOURCE_CODE;

    let appOpts;

    return Promise.resolve().then(() => {
      //由于注册时这里loadImpl的方法均是无参的，暂时忽略getProps的作用
      const loadPromise = app.loadImpl(getProps(app));
      if (!smellsLikeAPromise(loadPromise)) {
        // The name of the app will be prepended to this error message inside of the handleAppError function
        throw new UserError(`single-spa loading function did not return a promise. Check the second argument to registerApplication('${app.name}', loadingFunction, activityFunction)`);
      }
      //通过system.js加载模块js完成后，测试返回的值是什么,返回值很关键，是在依赖业务中打包时就存在的，拿到返回值后对vue声明时，singlespa设置的周期中的mount unmount bootstrap处理，并返回
      return loadPromise.then(val => {
        console.log('loadjs中加载完一个模块了');
        console.log(val);
        app.loadErrorTime = null;

        appOpts = val;

        let validationErrMessage;

        if (typeof appOpts !== 'object') {
          validationErrMessage = `does not export anything`;
        }

        if (!validLifecycleFn(appOpts.bootstrap)) {
          validationErrMessage = `does not export a bootstrap function or array of functions`;
        }

        if (!validLifecycleFn(appOpts.mount)) {
          validationErrMessage = `does not export a mount function or array of functions`;
        }

        if (!validLifecycleFn(appOpts.unmount)) {
          validationErrMessage = `does not export an unmount function or array of functions`;
        }

        if (validationErrMessage) {
          console.error(`The loading function for single-spa application '${app.name}' resolved with the following, which does not have bootstrap, mount, and unmount functions`, appOpts)
          handleAppError(validationErrMessage, app);
          app.status = SKIP_BECAUSE_BROKEN;
          return app;
        }

        if (appOpts.devtools && appOpts.devtools.overlays) {
          app.devtools.overlays = {...app.devtools.overlays, ...appOpts.devtools.overlays}
        }
        //BOOTSTRAPPED 独自创立
        app.status = NOT_BOOTSTRAPPED;
        //flatten 扁平化
        app.bootstrap = flattenFnArray(appOpts.bootstrap, `App '${app.name}' bootstrap function`);
        app.mount = flattenFnArray(appOpts.mount, `App '${app.name}' mount function`);
        app.unmount = flattenFnArray(appOpts.unmount, `App '${app.name}' unmount function`);
        app.unload = flattenFnArray(appOpts.unload || [], `App '${app.name}' unload function`);
        app.timeouts = ensureValidAppTimeouts(appOpts.timeouts);

        return app;
      })
    })
    .catch(err => {
      handleAppError(err, app);
      if (err instanceof UserError) {
        app.status = SKIP_BECAUSE_BROKEN;
      } else {
        app.status = LOAD_ERROR;
        app.loadErrorTime = new Date().getTime();
      }

      return app;
    })
  })
}
