/**
 * NAVBAR
 *
 * The navbar controller manages the bar at the top of the screen.
 */

var Amount = ripple.Amount,
    rewriter = require('../util/jsonrewriter');

var module = angular.module('navbar', []);

module.controller('NavbarCtrl', ['$scope', '$element', '$compile', 'rpId',
                                 'rpNetwork',
                                 function ($scope, el, $compile, $id,
                                           network)
{
  var queue = [];
  var tickInterval = 4000;
  var tickUpcoming = false;

  var tplAccount = require('../../jade/notification/account.jade');

  // Activate #status panel
  $scope.toggle_secondary = function () {
    $scope.show_secondary = !$scope.show_secondary;
  };

  $scope.$watch('balances', function () {
    $scope.orderedBalances = _.filter($scope.balances, function (balance) {
      // XXX Maybe we should show zero balances if there is outgoing trust in
      //     that currency.
      return !balance.total.is_zero();
    });
    $scope.orderedBalances.sort(function(a,b){
      return parseFloat(Math.abs(b.total.to_text())) - parseFloat(Math.abs(a.total.to_text()));
    });

    $scope.balance_count = $scope.orderedBalances.length;
  }, true);

  // Username
  $scope.$watch('userCredentials', function(){
    var username = $scope.userCredentials.username;
    $scope.shortUsername = null;
    if(username && username.length > 25) {
      $scope.shortUsername = username.substring(0,24)+"...";
    }
  }, true);

  $scope.logout = function () {
    // logout() assumes that we are outside of an Angular $apply(), so we need
    // to make sure that's actually the case otherwise we may get a
    // "Error: $apply already in progress"
    // XXX: Find out if there is a recommended/better way of doing this.
    setImmediate(function () {
      $id.logout();
    });
  };

  $scope.$on('$netConnected', function (e) {
    setConnectionStatus(true);
  });

  $scope.$on('$netDisconnected', function (e) {
    setConnectionStatus(false);
  });

  $scope.transactions = [];
  $scope.current_page = 1;

  // filter effect types
  // Show only offer_funded, offer_partially_funded, offer_cancelled,
  // offer_bought, trust_change_no_ripple side effects
  var filterEffects = function (tx) {
    if (!tx) return null;

    var event = jQuery.extend(true, {}, tx);
    var effects = [];

    if (event.effects) {
      $.each(event.effects, function(){
        var effect = this;
        if (effect.type == 'offer_funded'
            || effect.type == 'offer_partially_funded'
            || effect.type == 'offer_bought'
            || effect.type == 'trust_change_no_ripple'
            || effect.type === 'offer_cancelled')
        {
          if (effect.type === 'offer_cancelled' && event.transaction
              && event.transaction.type === 'offercancel') {
            return
          }
          effects.push(effect);
        }
      });

      event.showEffects = effects;
    }

    if (effects.length || event.transaction) {
      return event;
    } else {
      return null;
    }
  };

  $scope.reset = function () {
    $scope.transactions = [];
    $scope.has_more = true;
  };

  var marker;
  $scope.loadMore = function () {
    var account = $id.account;

    if (!$id.account) return;
    if ($scope.is_loading_more) return;
    if (!$scope.has_more) return;

    $scope.tx_load_status = 'loading';

    var params = {
      'account': account,
      'ledger_index_min': -1,
      //'binary': true,
      'limit': 8
    };

    if (marker) params.marker = marker;

    network.remote.request_account_tx(params)
      .on('success', function(data) {
        $scope.$apply(function () {
          if (data.transactions) {
            var transactions = [];

            if (data.marker) {
              // XXX There is a server-side bug right now:
              //     Instead of returning no marker if there are no more
              //     results, the server returns the marker it was given as an
              //     input.
              if (marker &&
                  "undefined" !== typeof data.marker.ledger &&
                  data.marker.ledger === marker.ledger &&
                  "undefined" !== typeof data.marker.seq &&
                  data.marker.seq === marker.seq) {
                $scope.has_more = false;
              } else {
                marker = data.marker;
              }
            } else $scope.has_more = false;

            data.transactions.forEach(function (e) {
              var tx = rewriter.processTxn(e.tx, e.meta, account);
              tx = filterEffects(tx);
              if (tx) {
                $scope.transactions.push(tx);
              }
            });

            // Loading mode
            $scope.tx_load_status = false;
          }
        });
      })
      .on('error', function(err){
        $scope.tx_load_status = 'error';
        console.log(err);
      }).request();
  };

  /**
   * Marks all the notifications as seen.
   */
  $scope.read = function() {
    var lastTx = $scope.transactions[0].hash;

    if ($scope.unseen > 0) {
      $scope.unseen = 0;
    }

    if ($scope.userBlob.data.lastSeenTxHash !== lastTx) {
      $scope.userBlob.set("/lastSeenTxHash", lastTx);

      $scope.unseen = $scope.unseenNotifications;
      $scope.unseenNotifications = 0;
    }
  };

  $scope.reset();
  $scope.loadMore();

  $scope.$on('$idAccountLoad', function () {
    $scope.reset();
    $scope.loadMore();
  });

  /**
   * Graphically display a network-related notifications.
   *
   * This function does no filtering - we assume that any transaction that makes
   * it here is ready to be rendered by the notification area.
   *
   * @param {Object} e Angular event object
   * @param {Object} tx Transaction info, returned from JsonRewriter#processTxn
   */
  $scope.$on('$appTxNotification', function (e, tx) {
    var $localScope = $scope.$new();
    $localScope.tx = tx.tx;

    var html = tplAccount($localScope);

    $scope.userBlob.unshift("/notifications", tx.hash);

    if (html.length) {
      var msg = $compile(html)($localScope);
      enqueue(msg);
    }
  });

  function setConnectionStatus(connected) {
    $scope.connected = !!connected;
    if (connected) {
      notifyEl.find('.type-offline').remove();
    } else {
      notifyEl.append('<div class="notification active type-offline">OFFLINE</div>');
    }
  }

  // A notification might have been queued already before the app was fully
  // initialized. If so, we display it now.
  if (queue.length) tick();

  var notifyEl = $('<div>').attr('id', 'notification').insertAfter(el);

  // Default to disconnected
  setTimeout(function() {
    setConnectionStatus($scope.connected);
  }, 1000 * 3);

  /**
   * Add the status message to the queue.
   */
  function enqueue(msg)
  {
    queue.push(msg);
    if (!tickUpcoming) {
      setImmediate(tick);
    }
  }

  /**
   * Proceed to next notification.
   */
  var prevEl = null;
  function tick()
  {
    if (prevEl) {
      // Hide notification box
      prevEl.removeClass('active');
      var prevElRef = prevEl;
      setTimeout(function () {
        prevElRef.remove();
      }, 1000);
      prevEl = null;
    }

    tickUpcoming = false;
    if (queue.length) {
      // Ensure secondary currencies pulldown is closed
      $scope.$apply(function() {
        $scope.show_secondary = false;
      });

      // Show next status message
      var next = queue.shift();

      var el = $(next);
      el.addClass('notification');
      el.appendTo(notifyEl);
      setImmediate(function () {
        el.addClass('active');
      });

      prevEl = el;

      tickUpcoming = true;
      setTimeout(tick, tickInterval);
    }
  }

  // Testing Hooks
  this.setConnectionStatus = setConnectionStatus;
  this.enqueue             = enqueue;
  this.tick                = tick;
}]);