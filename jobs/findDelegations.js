/**
 * The job to find delegations
 * @author:  MarcoXZh3
 * @version: 1.1.0
 */
var GetMembership = require('../memberships').GetMembership;
var MongoClient = require('mongodb').MongoClient;
var sql = require("mssql");


var moduleName = 'findDelegations';

/**
 * find and save new delegations
 * @param {json}        options     the options for the job
 * @param {function}    callback    the callback function
 *      @param {array}      newDeles    array of new delegations
 */
module.exports = function(options, callback) {
    var query = (`SELECT * FROM TxDelegateVestingShares ` + // the target table
                 `WHERE delegatee = N'cnbuddy'`);           // only cnbuddy

    sql.connect(options.sqlserver, function(err) {
        if (err) {
            options.loggers[1].log('error',
                                   '<' + moduleName + '.sql.connect> ' +
                                   err.message);
            if (callback) {
                callback(err);
            } // if (callback)
            return err;
        } // if (err)
        new sql.Request().query(query, function(err, res) {
            if (err) {
                options.loggers[1].log('error',
                                       '<' + moduleName + '.sql.Request.query> ' +
                                       err.message);
                if (callback) {
                    callback(err);
                } // if (callback)
                return err;
            } // if (err)

            // Deal with these delegation records
            sql.close();
            return SaveDelegationsToDb(
                options,
                res.recordset.map(function(e) {
                    return e.delegator === 'steem' ? null : {
                        'delegator': e.delegator,
                        'time':      e.timestamp,
                        'vests':     e.vesting_shares
                    }; // return { ... };
                }).filter( (e)=>e ),
                callback);
        }); // new sql.Request().query(sql1, function(err, res) { ... });
    }); // sql.connect(options.sqlserver, function(err) { ... });
}; // module.exports = function(options, callback)

/**
 * Save delegations to database
 * @param {json}        options     the options for the job
 * @param {array}       allDeles    the list of all delegations
 * @param {function}    callback    the callback function
 *      @param {array}      newDeles    array of new delegations
 */
var SaveDelegationsToDb = function(options, allDeles, callback) {
    MongoClient.connect(options.database, function(err, db) {
        if (err) {
            options.loggers[0].log('error',
                                   '<' + moduleName + '.MongoClient.connect> ' +
                                   err.message);
            if (callback) {
                callback(err);
            } // if (callback)
            return err;
        } // if (err)
        db.collection('delegations').find({}).toArray(function(err, res) {
            if (err) {
                options.loggers[1].log('error',
                                       '<' + moduleName + '.db.cners.find> ' +
                                       err.message);
                if (callback) {
                    callback(err);
                } // if (callback)
                return err;
            } // if (err)

            var times = res.map( (d)=>d.time.getTime() );
            var newDeles = allDeles.filter( (d)=>!times.includes(d.time.getTime()) );
            if (newDeles.length === 0) {
                db.close();
                options.loggers[1].log('info',
                                       '<' + moduleName + '> No new delegations found');
                if (callback) {
                    callback(newDeles);
                } // if (callback)
                return newDeles;
            } // if (newDeles.length === 0)

            db.collection('delegations').insertMany(newDeles, null, function(err, r) {
                if (err) {
                    options.loggers[1].log('error',
                                           '<' + moduleName + '.db.cners.insertMany> ' +
                                           err.message);
                    return err;
                } // if (err)
            }); // db.collection('delegations').insertMany( ... );

            // Log - all the people with new delegations
            newDeles.forEach(function(d, idx, arr) {
                options.loggers[1].log('info',
                                       '<' + moduleName + '> New delegation found (' +
                                       (idx+1) + '/' + arr.length + '): '
                                       + d.delegator + '[' + d.vests + ', '
                                       + d.time.toISOString() + ']');
            }); // newDeles.forEach(function(d, idx, arr) { ... });

            // Save the new memberships
            SaveMembership(options, db, allDeles, function(err) {
                if (callback) {
                    callback(err ? err : newDeles);
                } // if (callback)
                return err ? err : newDeles;
            }); // SaveMembership(options, db, allDeles, function() {err});
        }); // db.collection('delegations').find({}).toArray(... ):
    }); // MongoClient.connect(options.database, function(err, db) { ... });
}; // var SaveDelegationsToDb = function(options, allDeles, callback) { ... };

/**
 * Save membership to cners
 * @param {json}        options     the options for the job
 * @param {object}      db          the database handle
 * @param {array}       allDeles    the list of all delegations
 * @param {function}    callback    the callback function
 *      @param {array}      newDeles    array of new delegations
 */
var SaveMembership = function(options, db, allDeles, callback) {
    // Merge the new delegations according to delegator names
    var delegations = {};
    allDeles.sort( (a,b)=>a.time.getTime() - b.time.getTime() )
            .forEach(function(e,i,arr) {
        delegations[e.delegator] = { time:e.time, vests:e.vests };
    }); // allDeles.sort( ... ).forEach( ... );

    // Update memberships
    db.collection('cners').find({}).toArray(function(err, res) {
        if (err) {
            options.loggers[1].log('error',
                                   '<' + moduleName + '.db.cners.find> ' +
                                   err.message);
            if (callback) {
                callback(err);
            } // if (callback)
            return err;
        } // if (err)
        res = res.map( (e)=>e.name );
        var oldCners = [];
        var newCners = [];
        Object.keys(delegations).forEach(function(e) {
            var membership = GetMembership({
                    delegator:  e,
                    time:       delegations[e].time,
                    vests:      delegations[e].vests
                },
                options.total_vesting_shares,
                options.total_vesting_fund_steem
            ); // var membership = GetMembership({ ... };
            if (res.includes(e)) {              // old cner with new delegation
                oldCners.push({
                    filter: { name:e },
                    update: {
                        $set: {
                            membership: membership,
                            membertime: delegations[e].time,
                            vests:      delegations[e].vests
                        } // $set: { ... }
                    } // updte: { ... }
                }); // oldCners.push({ ... });
            } else {                            // new cner with delegation
                newCners.push({
                    name:       e,
                    membership: membership,
                    membertime: delegations[e].time,
                    vests:      delegations[e].vests,
                    follower:   false
                }); // newCners.push({ ... });
            } // else - if (res.includes(e))
        }); // Object.keys.delegations.forEach(function(e) { ... });

        SaveMembershipToDb(options, db, newCners, oldCners, function(err) {
            if (callback) {
                callback(err ? err : null);
            } // if (callback)
            return err ? err : null;
        }); // SaveMembershipToDb(options, db, newCners, oldCners, function() {});
    }); // db.collection('cners').find({}).toArray( ... );
}; // var SaveMembership = function(options, db, allDeles, callback) { ... };

/**
 * Save membership to database
 * @param {json}        options     the options for the job
 * @param {object}      db          the database handle
 * @param {array}       newCners    the list of new cners according to delegations
 * @param {array}       oldCners    the list of old cners with delegations
 * @param {function}    callback    the callback function
 *      @param {array}      newDeles    array of new delegations
 */
var SaveMembershipToDb = function(options, db, newCners, oldCners, callback) {
    var jobInsertDone = false;
    var jobUpdateDone = false;

    // New cners with new delegation - insert
    if (newCners.length === 0) {
        jobInsertDone = true;
        if (jobUpdateDone && jobInsertDone) {
            db.close();
            if (callback) {
                callback();
            } // if (callback)
            return ;
        } // if (jobUpdateDone && jobInsertDone)
    } else {
        db.collection('cners').insertMany(newCners, function(err, res) {
            if (err) {
                options.loggers[1].log('error',
                                       '<' + moduleName + '.db.cners.insertMany> ' +
                                       err.message);
                if (callback) {
                    callback(err);
                } // if (callback)
                return err;
            } // if (err)
            jobInsertDone = true;
            if (jobUpdateDone && jobInsertDone) {
                db.close();
                if (callback) {
                    callback();
                } // if (callback)
                return ;
            } // if (jobUpdateDone && jobInsertDone)
        }); // db.collection('cners').update( ... );
    }// if (newCners.length === 0)

    // Current cners with new delegations - update
    if (oldCners.length === 0) {
        jobUpdateDone = true;
        if (jobUpdateDone && jobInsertDone) {
            db.close();
            if (callback) {
                callback();
            } // if (callback)
            return ;
        } // if (jobUpdateDone && jobInsertDone)
    } else {
        oldCners.forEach(function(e, idx, arr) {
            db.collection('cners').update(e.filter, e.update, function(err, res) {
                if (err) {
                    options.loggers[1].log('error',
                                           '<' + moduleName + '.db.cners.update> ' +
                                           err.message);
                    if (callback) {
                        callback(err);
                    } // if (callback)
                    return err;
                } // if (err)
                if (idx === arr.length - 1) {
                    jobUpdateDone = true;
                    if (jobUpdateDone && jobInsertDone) {
                        db.close();
                        if (callback) {
                            callback();
                        } // if (callback)
                        return ;
                    } // if (jobUpdateDone && jobInsertDone)
                } // if (idx === arr.length - 1)
            }); // db.collection('cners').update( ... );
        }); // oldCners.forEach(function(e, idx, arr) { ... });
    } // else - if (oldCners.length === 0)

}; // var SaveMembershipToDb = function(options, db, oldCners, newCners, callback) { ... };
