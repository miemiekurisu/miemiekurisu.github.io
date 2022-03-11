---
permalink: /spark/task
layout: default
---

## 任务执行过程

问题：

- 一个Spark任务究竟是怎么执行的？

### 一个Spark任务究竟是怎么执行的

老实说，我不知道从哪里开始，
考虑到一般Spark程序通过 `spark-submit` 或 `spark-shell` 提交之后，
最终其实只会以 `write` 和 `collect` 进行实际执行，所以就从这2个函数入手。

~~`write`可能会比较复杂，涉及到实际存储，所以只是为了搞清楚执行过程，~~
~~还是从 `collect` 方法会比较简单。~~

~~所以我决定从一段简单的REPL代码入手：~~

半途发现任务序列化有点[区别](#diff)，所以就把groupRDD改成了下面的代码：

```diff
-   val groupRdd = sc.parallelize(Seq((1,2),(3,4),(5,6),(1,5),(3,8)))
+   val groupRdd = sc.textFile("D:\\test.csv").map(
+     x => {
+       val p = x.split(",")
+       ( p(0) , p(1) )
+   })

    val shuffRDD = groupRdd.groupByKey()
    shuffRDD.collect
```

挑了一个会产生`ShuffledRDD`的`groupByKey` 函数，这个函数在 `PairRDDFunctions` 里，在 `RDD` 本身代码里是找不到的。

顺便提一下这个 `PairRDDFunctions`，签名是这样的：

```scala
    class PairRDDFunctions[K, V](self: RDD[(K, V)])
    (implicit kt: ClassTag[K], vt: ClassTag[V], ord: Ordering[K] = null)
  extends Logging with Serializable
```

这里用了scala的隐式转换，把RDD转换为一个`PairRDDFunctions`，
隐含的参数是pairRDD中包含的key和value的ClassTag，由于不确定RDD中key和value的类型，
采用了常见的隐式参数保留运行时类型信息。(看不明白的补一下`ClassTag`)

把RDD转换为 `PairRDDFunctions`的隐式转换方法在spark 1.3之前需要 `import SparkContext._`,
1.3之后挪到了RDD的 `rddToPairRDDFunctions` 方法里。

在[上一节](/spark/rdd/#createPCR)，我们已经看到 `groupRdd` 是个 `ParallelCollectionRDD`，
接下来我们看看产生shuffRDD的`groupByKey`函数：

```scala
    def groupByKey(partitioner: Partitioner): RDD[(K, Iterable[V])] = self.withScope {
    // groupByKey shouldn't use map side combine because map side combine does not
    // reduce the amount of data shuffled and requires all map side data be inserted
    // into a hash table, leading to more objects in the old gen.

    // 这里实际传入的是CompactBuffer伴生类的apply函数
    val createCombiner = (v: V) => CompactBuffer(v)
    val mergeValue = (buf: CompactBuffer[V], v: V) => buf += v
    val mergeCombiners = (c1: CompactBuffer[V], c2: CompactBuffer[V]) => c1 ++= c2
    val bufs = combineByKeyWithClassTag[CompactBuffer[V]](
      createCombiner, mergeValue, mergeCombiners, partitioner, mapSideCombine = false)
    bufs.asInstanceOf[RDD[(K, Iterable[V])]]
  }
```

可以看到方法先建了一个`CompactBuffer`关于`CompactBuffer`的进一步深挖可以看[这里](/spark/appendix/appendix/#CompactBuffer)，
外加定义了两个个函数，作为参数传入 `combineByKeyWithClassTag`，我们继续下到该函数里：

```scala
      def combineByKeyWithClassTag[C](
      createCombiner: V => C,
      mergeValue: (C, V) => C,
      mergeCombiners: (C, C) => C,
      partitioner: Partitioner,
      mapSideCombine: Boolean = true,
      serializer: Serializer = null)(implicit ct: ClassTag[C]): RDD[(K, C)] = self.withScope {
    require(mergeCombiners != null, "mergeCombiners must be defined") // required as of Spark 0.9.0
    if (keyClass.isArray) {
      if (mapSideCombine) {
        throw new SparkException("Cannot use map-side combining with array keys.")
      }
      if (partitioner.isInstanceOf[HashPartitioner]) {
        throw new SparkException("HashPartitioner cannot partition array keys.")
      }
    }
    val aggregator = new Aggregator[K, V, C](
      self.context.clean(createCombiner),
      self.context.clean(mergeValue),
      self.context.clean(mergeCombiners))
    if (self.partitioner == Some(partitioner)) {
      self.mapPartitions(iter => {
        val context = TaskContext.get()
        new InterruptibleIterator(context, aggregator.combineValuesByKey(iter, context))
      }, preservesPartitioning = true)
    } else {
      new ShuffledRDD[K, V, C](self, partitioner)
        .setSerializer(serializer)
        .setAggregator(aggregator)
        .setMapSideCombine(mapSideCombine)
    }
  }
```

这个函数在2.4里还是带 `@Experimental` 的，最新版里已经去掉了这个注解，看来大家对它很满意=^_^=。

这是一个通用的pairRDD聚合方法，把 `RDD[(K,V)]` 转换成 `RDD[(K,CombinedType)]`。

注意，这个方法是public的，也就是说有必要的话可以通过自定义以下三个聚合函数，创建自己的聚合方法：

  1. `createCombiner`：用来将创建包含单个V类型元素的某种C集合类型（比如说 val custom1 = (i:Int) => Seq(i)，当然上面用的是`CompactBuffer`）
  2. `mergeValue`：用来将单个V元素添加到C集合里去（比如说 val custom2 = (c:Seq[Int],i:Int) => c:+i）
  3. `mergeCombiners`：用来聚合C集合（比如说 val custom3 = (c1:Seq[Int],c2:Seq[Int])=>c1++c2）

欸嘿，我们这就顺手自定义了一个简版的聚合函数，给它们起个可爱的名字（当然也可以匿名）：

```scala
 val miemie1 = (i:Int) => Seq(i)
 val miemie2 = (c:Seq[Int],i:Int) => c:+i
 val miemie3 = (c1:Seq[Int],c2:Seq[Int])=>c1++c2
groupRdd.combineByKeyWithClassTag(miemie1,miemie2,miemie3)
groupRdd.combineByKeyWithClassTag(miemie1,miemie2,miemie3).collect
```

执行结果如下：
![avatar][results1]
是不是很有趣？

下面的`Aggregator`就不往下深挖了，本篇的主要目的还是看任务执行。

快进到`collect`函数：

```scala
  def collect(): Array[T] = withScope {
    val results = sc.runJob(this, (iter: Iterator[T]) => iter.toArray)
    Array.concat(results: _*)
  }
```

很简单，就2行，可以看出第二行是个对Driver压力很大的操作，

直接把各服务器上返回的`Iterator`返回成`Array`，再合并成一个，如果数据较多的话显然对Driver产生很大的内存压力。

一路往下我们可以看到调用链是这样的：

`RDD.collect => sparkContext.runJob (当中套了好几次runJob的多态函数)=> dagScheduler.runJob =>dagScheduler.submitJob`

一路最后来到`DAGScheuler`的`submitJob`函数：

```scala
def submitJob[T, U](
      rdd: RDD[T],
      func: (TaskContext, Iterator[T]) => U,
      partitions: Seq[Int],
      callSite: CallSite,
      resultHandler: (Int, U) => Unit,
      properties: Properties): JobWaiter[U] = {

          //...省略
    // 真正提交任务的就这么2句：
    // 先创建一个waiter，waiter的主要工作是在运行时向dagScheduler上报一些状态信息，同时控制任务工作
     val waiter = new JobWaiter(this, jobId, partitions.size, resultHandler)
     //费了九牛二虎之力，终于把任务提交上去了
    eventProcessLoop.post(JobSubmitted(
      jobId, rdd, func2, partitions.toArray, callSite, waiter,
      SerializationUtils.clone(properties)))
      //...省略
      }
```

`submitJob`把这个event提交到了这里，兴冲冲点进去一看，结果只有：

```scala
      /**
   * Put the event into the event queue. The event thread will process it later.
   */
   // 注意这里的eventQueue，采用了`LinkedBlockingDeque`的线程安全双向链表并发阻塞队列
  def post(event: E): Unit = {
    eventQueue.put(event)
  }
```

摔(′д｀ )…彡…彡，在`post`和`put`里也只是将获得的event提交上去而已，那么真正执行在哪里呢？

有post当然就有Receive，上面我们说的`LinkedBlockingDeque`楼下就有个`eventThread`

此处注意的是，这段获取事件队列的线程循环代码虽然在`EventLoop`里，

但实际上运行时调用的是其子类`DAGSchedulerEventProcessLoop`

（2.x里`EventLoop`的正经子类实现，`spark-core`里也就只有这么一个，其他都在testSuit里）

所以这个`onReceive`其实是`DAGSchedulerEventProcessLoop`里override的方法。

```scala
      private[spark] val eventThread = new Thread(name) {
    setDaemon(true)

    override def run(): Unit = {
      try {
        while (!stopped.get) {
            // 从队列里取出事件
          val event = eventQueue.take()
          try {
              // 交给子类的onReceive
            onReceive(event)
          } catch {
              //省略异常处理……
          }
        }
      } catch {
          // 省略异常处理……
      }
    }

  }
```

那么 `DAGSchedulerEventProcessLoop` 是怎么处理的呢？

```scala
     private def doOnReceive(event: DAGSchedulerEvent): Unit = event match {
         // 直接跳转到DAGScheduler的handleJobSubmitted方法
    case JobSubmitted(jobId, rdd, func, partitions, callSite, listener, properties) =>
      dagScheduler.handleJobSubmitted(jobId, rdd, func, partitions, callSite, listener, properties)
      // 加上这次我们主要看的JobSubmitted，一共有14种event
      // 省略其他event的处理……
     }
```

{: result_stage}

```scala
    private[scheduler] def handleJobSubmitted(jobId: Int,
      finalRDD: RDD[_],
      func: (TaskContext, Iterator[_]) => _,
      partitions: Array[Int],
      callSite: CallSite,
      listener: JobListener,
      properties: Properties) {
    var finalStage: ResultStage = null
    try {
      // New stage creation may throw an exception if, for example, jobs are run on a
      // HadoopRDD whose underlying HDFS files have been deleted.
      // 建立最终stage
      finalStage = createResultStage(finalRDD, func, partitions, jobId, callSite)
    } catch {
        // 此处省略一些异常处理的消息上报，值得一提的是有2个默认值，
        // 最大重试次数 maxFailureNumTasksCheck 40
        // 如果有错误则会新增一个messageScheduler来重新提交一遍进eventProcessLoop
        // 延迟时间timeIntervalNumTasksCheck为15秒
    }

    //……这里暂时省略到下半场
    }
```

{: result_part}

后面的调用链有点长：

```text
DAGScheduler.createResultStage => 
    DAGScheduler.getOrCreateParentStages => 
        DAGScheduler.getShuffleDependencies =>
            DAGScheduler.getOrCreateShuffleMapStage =>
                DAGScheduler.getMissingAncestorShuffleDependencies (需要补stage的时候)

```

这里是真正计算Shuffle依赖关系的地方：

```scala
    /**
    简单翻译一下注释，这个方法只会返回直接的parent，
    如果存在 A <- B <- C的依赖，则只会返回 B--C 的依赖
   */
  private[scheduler] def getShuffleDependencies(
      rdd: RDD[_]): HashSet[ShuffleDependency[_, _, _]] = {
          // 生成3个HashSet 来进行过滤
    val parents = new HashSet[ShuffleDependency[_, _, _]]
    val visited = new HashSet[RDD[_]]
    val waitingForVisit = new ArrayStack[RDD[_]]
    waitingForVisit.push(rdd)
    while (waitingForVisit.nonEmpty) {
      val toVisit = waitingForVisit.pop()
      if (!visited(toVisit)) {
        visited += toVisit
        //注意这里！
        toVisit.dependencies.foreach {
          case shuffleDep: ShuffleDependency[_, _, _] =>
            parents += shuffleDep
          case dependency =>
            waitingForVisit.push(dependency.rdd)
        }
      }
    }
    parents
  }
```

注意`toVisit.dependencies`，这里同样调用了`dependencies`方法，还[记得吗？](/spark/rdd/#pred_deps)

如其名，在这个函数里会对每一个当前RDD依赖的每一个RDD进行遍历，求它的`ShuffleDependency`，

它是`Dependency`的子类，内部加入了一些shuffle专用的方法，先留个[坑](/spark/shuffle),

后续研究shuffle过程的时候再仔细看。

实际上就是传递了一个shuffle的依赖链返回给`getOrCreateParentStages`，
对每一个shuffleDep求`getOrCreateShuffleMapStage`：

```scala
    /**
   * 简而言之就是前面有stage就取stage，没有就补一下
   */
  private def getOrCreateShuffleMapStage(
      shuffleDep: ShuffleDependency[_, _, _],
      firstJobId: Int): ShuffleMapStage = {
          // shuffleIdToMapStage 是个HashMap[Int, ShuffleMapStage]
    shuffleIdToMapStage.get(shuffleDep.shuffleId) match {
        // 注意这里的stage是  ShuffleMapStage，即函数定义的返回值
      case Some(stage) =>
        stage

      case None =>
        // 按上面的代码，DAGScheduler里肯定是个空的HashMap咯，那就开始补
        // 注意这里补全部shuffle依赖，这里用了 ancestor，不确定是不是会追溯再之前的stage依赖。
        // 继续往下看
        // 这个函数的内容跟之前 getShuffleDependencies 的内容几乎是一样的，
        // 实际上关键的寻找shuffle依赖部分用的还是getShuffleDependencies
        // 只是循环查找的是之前每个RDD里是否存在shuffleStage生成。
        // 这个例子里是没有的，所以这段代码就被跳过了。
        getMissingAncestorShuffleDependencies(shuffleDep.rdd).foreach { dep =>
          // Even though getMissingAncestorShuffleDependencies only returns shuffle dependencies
          // that were not already in shuffleIdToMapStage, it's possible that by the time we
          // get to a particular dependency in the foreach loop, it's been added to
          // shuffleIdToMapStage by the stage creation process for an earlier dependency. See
          // SPARK-13902 for more information.
          // createShuffleMapStage函数会生成shuffleMapStage，并且扔进shuffleIdToMapStage
          // 关于这部分，下次在Shuffle过程里做个例子详细研究
          if (!shuffleIdToMapStage.contains(dep.shuffleId)) {
            createShuffleMapStage(dep, firstJobId)
          }
        }
        // Finally, create a stage for the given shuffle dependency.
        // 为当前shuffleDependancy生成shuffleMapStage，并且扔进shuffleIdToMapStage里
        createShuffleMapStage(shuffleDep, firstJobId)
    }
  }
```

再继续往下，进入到`createShuffleMapStage`，我们平时spark UI里看到的stages，就是在这里生成的：

```scala
      def createShuffleMapStage(shuffleDep: ShuffleDependency[_, _, _], jobId: Int): ShuffleMapStage = {
    val rdd = shuffleDep.rdd
    //……省略 BarrierStage 的检查
    // 任务数是由shuffleDep的rdd分区数量决定的
    val numTasks = rdd.partitions.length
    // 这里又调用一次，spark团队你有多害怕漏了前置依赖啊。。。
    val parents = getOrCreateParentStages(rdd, jobId)
    // 直接分配stage的id，注意这是在DAGScheduler里以并发安全方式分配的
    val id = nextStageId.getAndIncrement()
    // 生成新的 shuffleMapStage
    // 注意这里的 mapOutputTracker，这是在DAGScheduler生成的时候就同时生成的
    // 这是一个 MapOutputTrackerMaster 类，对这个类说明：
    // Driver-side class that keeps track of the location of the map output of a stage.
    // 就是用来指明map之后产生的数据去哪里拿的，用来提供信息给reduce程序
    // 然后这个creationSite也很有意思，这个creationSite就是创建这个RDD的代码文本（RDD里乱七八糟的东西还真多）
    val stage = new ShuffleMapStage(
      id, rdd, numTasks, parents, jobId, rdd.creationSite, shuffleDep, mapOutputTracker)

    stageIdToStage(id) = stage
    shuffleIdToMapStage(shuffleDep.shuffleId) = stage
    updateJobIdStageIdMaps(jobId, stage)

    if (!mapOutputTracker.containsShuffle(shuffleDep.shuffleId)) {
      // Kind of ugly: need to register RDDs with the cache and map output tracker here
      // since we can't do it in the RDD constructor because # of partitions is unknown
      // 这里算官方吐槽了吧……
      logInfo("Registering RDD " + rdd.id + " (" + rdd.getCreationSite + ")")
      // 去 mapOutputTracker （MapOutputTrackerMaster）里注册
      mapOutputTracker.registerShuffle(shuffleDep.shuffleId, rdd.partitions.length)
    }
    stage
  }
```

这个函数主要修改了DAGScheduler的3个内部变量，有趣的是这3个都是HashMap：

- jobIdToStageIds：内部变量 `nextJobId` 产生的 JobId 和`nextStageId`产生的 StageId 的对应关系，
  是最后被`updateJobIdStageIdMaps`递归修改的
- stageIdToStage：最先被修改的，`nextStageId`产生的 StageId 与实际Stage之间的关系
- shuffleIdToMapStage：`newShuffleId` 产生的ShuffleId与MapStage的关系，
  注意这个`newShuffleId`是sparkContext的方法，也就是说这个shuffleId是sparkContext层面的唯一。

好了，shuffleStage终于完成了DAG生成、创建、注册的一系列过程，终于可以[返回](#createResultStage)了，
此时ResultStage已经生成，回到[`handleJobSubmitted`](#result_part)的下半场:

```scala
    private[scheduler] def handleJobSubmitted(jobId: Int,
      finalRDD: RDD[_],
      func: (TaskContext, Iterator[_]) => _,
      partitions: Array[Int],
      callSite: CallSite,
      listener: JobListener,
      properties: Properties) {
        //……此处省略上半场
        // resultStage已生成
    
    // 用上面的信息创建一个ActiveJob
     val job = new ActiveJob(jobId, finalStage, callSite, listener, properties)
     //清除RDD的分区和位置缓存信息，注意这个方法是synchronized
    clearCacheLocs()
    //……省略一些日志……日志里还不放心，还要调一次getMissingParentStages

    val jobSubmissionTime = clock.getTimeMillis()
    // 把这个ActiveJob放进 DAGScheduler 的 jobIdToActiveJob 里，后面会用到
    jobIdToActiveJob(jobId) = job
    activeJobs += job
    finalStage.setActiveJob(job)
    // 注意这里，上面更新 jobIdToStageIds 的用处来了，这个测试job有2个stage
    // 一个 shuffleStage <- 0，一个 resultStage <- 1
    val stageIds = jobIdToStageIds(jobId).toArray
    // 获取信息
    val stageInfos = stageIds.flatMap(id => stageIdToStage.get(id).map(_.latestInfo))
    // 先提交给 LiveListenerBus 注册一个事件，这个事件实际上会通过 trait SparkListenerBus 转发 
    // 实现类是 AsyncEventQueue
    listenerBus.post(
      SparkListenerJobStart(job.jobId, jobSubmissionTime, stageInfos, properties))
    // 把最终stage提交上去
    submitStage(finalStage)
  }
    }
```

接着看这个 `submitStage`:

```scala
    /** Submits stage, but first recursively submits any missing parents. */
  private def submitStage(stage: Stage) {
    // 把stage的jobId取出来，然后从上一个方法更新过的 jobIdToActiveJob 里找相应的jobId 并取出来 
    // 实际上就是确定当前需要跑的ActiveJob的Id
    // 注意它返回的是个Option，可能没有符合条件的jobId
    val jobId = activeJobForStage(stage)
    if (jobId.isDefined) {
      logDebug("submitStage(" + stage + ")")
      if (!waitingStages(stage) && !runningStages(stage) && !failedStages(stage)) {
          // 我们的老朋友 getMissingParentStages，看来无时无刻不担心stage发生变化……
          // 从方法注释上看这个方法的目的是递归提交stage，直到之前的父stage都跑完
          // 所以可以理解每次都需要重新计算一下之前的stages的状态
        val missing = getMissingParentStages(stage).sortBy(_.id)
        logDebug("missing: " + missing)
        if (missing.isEmpty) {
          logInfo("Submitting " + stage + " (" + stage.rdd + "), which has no missing parents")
          // 激动吧？我们兜了这么大一圈，终于看到真正提交Task的地方了
          submitMissingTasks(stage, jobId.get)
        } else {
          for (parent <- missing) {
              // 递归提交上一层stage
            submitStage(parent)
          }
          waitingStages += stage
        }
      }
    } else {
      abortStage(stage, "No active job for stage " + stage.id, None)
    }
  }
```

来，我们看看这个 `submitMissingTasks`(这个方法好长……酌情省略):

```scala
      /** Called when stage's parents are available and we can now do its task. */
  private def submitMissingTasks(stage: Stage, jobId: Int) {
    logDebug("submitMissingTasks(" + stage + ")")

    // First figure out the indexes of partition ids to compute.
    // 先取stage的partition，之前说了，Stage是个抽象类，它的实现只有2种：
    // ShuffleMapStage 和 ResultStage，结合测试代码看，第一次调用此方法的肯定是ShuffleMapStage
    // 还记得之前创建ShuffleMapStage的构造函数吗？创建的时候传入了一个MapOutputTrackerMaster
    // 由这个 MapOutputTrackerMaster 决定 ShuffleMapStage的物理位置
    val partitionsToCompute: Seq[Int] = stage.findMissingPartitions()

    // Use the scheduling pool, job group, description, etc. from an ActiveJob associated
    // with this Stage
    // 获得一些配置，这个properties将来执行任务会用到
    val properties = jobIdToActiveJob(jobId).properties

    //把当前stage加入执行队列
    runningStages += stage
    // SparkListenerStageSubmitted should be posted before testing whether tasks are
    // serializable. If tasks are not serializable, a SparkListenerStageCompleted event
    // will be posted, which should always come after a corresponding SparkListenerStageSubmitted
    // event.
    stage match {
      case s: ShuffleMapStage =>
      // 这个 outputCommitCoordinator 可厉害了，是Spark集群启动时维护的 OutputCommitCoordinator 对象
      // 它会同时跟踪 task Id 和 stage Id，用来避免某些情况下同一个 stage 的 task 执行两遍，
      // 通过在内部维护着一个私有变量stageStates来决定partition上的task是否有权对这个partition提交任务输出。
      // 这部分实现被修改过，在2.0和1.x时代通过一个内部变量 authorizedCommittersByStage 来实现
      // 详细实现下次开个坑说吧，这里调用stageStart主要就是对task进行授权注册，表示这个stage要开始执行了。
      // 注意 stageStart 这个方法是 synchronized 的。
        outputCommitCoordinator.stageStart(stage = s.id, maxPartitionId = s.numPartitions - 1)
      case s: ResultStage =>
        outputCommitCoordinator.stageStart(
          stage = s.id, maxPartitionId = s.rdd.partitions.length - 1)
    }
    /**
    // 敲重点：getPreferredLocs
    // 看名字就知道了吧，这里是对执行的最佳物理位置的计算
    // 主要调用链是：getPreferredLocs => getPreferredLocsInternal => rdd.preferredLocations =>
    // MapOutputTrackerMaster.getPreferredLocationsForShuffle
    // 在 getPreferredLocsInternal 里把 RDD 的 partition 取出来（这里会重新检查一下分区），
    // 传入 RDD 的 preferredLocations 里。
    // 注意这里的RDD，我们的测试例子里第一个产生的是 ShuffledRDD ，在 ShuffledRDD 里 overwrite 了这个方法。
    // ShuffledRDD 的 preferredLocations 里，
    // 会把第一个 dependencies 依赖和 partition 的index 传进 MapOutputTrackerMaster (SprakEnv里get出来) 
    // 的 getPreferredLocationsForShuffle 函数里。
    // 敲重点，优化注意！
       在上述方法里有3个阈值变量，都是静态直接写死的，分别是：
        1. SHUFFLE_PREF_MAP_THRESHOLD = 1000 
        2. SHUFFLE_PREF_REDUCE_THRESHOLD =1000
        3. REDUCER_PREF_LOCS_FRACTION = 0.2 
       1和2代表了map和reduce的分区上限，超过这个数都会直接跳过最佳物理位置计算，
       理由是超过了这2个数，计算最佳位置本身就很耗时。
       3是最佳物理位置计算时每个location时大于这个阈值则视为reduce任务的首选位置，
        把这个值放大的话会更倾向于本地读取数据，但如果该位置很忙的话，会带来更多调度延迟。
    */
    val taskIdToLocations: Map[Int, Seq[TaskLocation]] = try {
      stage match {
        case s: ShuffleMapStage =>
          partitionsToCompute.map { id => (id, getPreferredLocs(stage.rdd, id))}.toMap
        case s: ResultStage =>
          partitionsToCompute.map { id =>
            val p = s.partitions(id)
            (id, getPreferredLocs(stage.rdd, p))
          }.toMap
      }
    } catch {
      case NonFatal(e) =>
        stage.makeNewStageAttempt(partitionsToCompute.size)
        listenerBus.post(SparkListenerStageSubmitted(stage.latestInfo, properties))
        abortStage(stage, s"Task creation failed: $e\n${Utils.exceptionString(e)}", Some(e))
        runningStages -= stage
        return
    }

    // 最后我们从 taskIdToLocations 得到了分区与最佳位置的对应关系
    // 这里会注册一个 TaskMetrics 统计stage的相关信息
    stage.makeNewStageAttempt(partitionsToCompute.size, taskIdToLocations.values.toSeq)

    //……省略部分代码 

    // 照例向ListenerBus上报一个event
    listenerBus.post(SparkListenerStageSubmitted(stage.latestInfo, properties))

    // TODO: Maybe we can keep the taskBinary in Stage to avoid serializing it multiple times.
    // Broadcasted binary for the task, used to dispatch tasks to executors. Note that we broadcast
    // the serialized copy of the RDD and for each task we will deserialize it, which means each
    // task gets a different copy of the RDD. This provides stronger isolation between tasks that
    // might modify state of objects referenced in their closures. This is necessary in Hadoop
    // where the JobConf/Configuration object is not thread-safe.
    // 开始了开始了，把RDD和shuffleDep序列化，然后广播出去
    var taskBinary: Broadcast[Array[Byte]] = null
    var partitions: Array[Partition] = null
    try {
      // For ShuffleMapTask, serialize and broadcast (rdd, shuffleDep).
      // For ResultTask, serialize and broadcast (rdd, func).
      var taskBinaryBytes: Array[Byte] = null
      // taskBinaryBytes and partitions are both effected by the checkpoint status. We need
      // this synchronization in case another concurrent job is checkpointing this RDD, so we get a
      // consistent view of both variables.
      RDDCheckpointData.synchronized {
        taskBinaryBytes = stage match {
          // 这里遇到的问题，ParallelCollectionRDD 的话这个地方会直接把内部的data一起序列化广播出去
          // HadoopRDD则会不会有data传递
          case stage: ShuffleMapStage =>
            JavaUtils.bufferToArray(
              closureSerializer.serialize((stage.rdd, stage.shuffleDep): AnyRef))
          case stage: ResultStage =>
            JavaUtils.bufferToArray(closureSerializer.serialize((stage.rdd, stage.func): AnyRef))
        }

        partitions = stage.rdd.partitions
      }
      // 广播序列化后的任务数据
      taskBinary = sc.broadcast(taskBinaryBytes)
    } catch {
        // …… 序列化失败时的一些异常处理
    }

    val tasks: Seq[Task[_]] = try {
      val serializedTaskMetrics = closureSerializer.serialize(stage.latestInfo.taskMetrics).array()
      stage match {
        case stage: ShuffleMapStage =>
          stage.pendingPartitions.clear()
          // 对每一个Partitions新生成一个Task，
          // Task是个抽象类，只有两种有效实现，跟stage一样，ShuffleMapTast和ResultTask
          partitionsToCompute.map { id =>
            // 这个时候用到了之前计算的task和位置的关系
            val locs = taskIdToLocations(id)
            val part = partitions(id)
            stage.pendingPartitions += id
            new ShuffleMapTask(stage.id, stage.latestInfo.attemptNumber,
              taskBinary, part, locs, properties, serializedTaskMetrics, Option(jobId),
              Option(sc.applicationId), sc.applicationAttemptId, stage.rdd.isBarrier())
          }

        case stage: ResultStage =>
          // ……省略resultTask生成处理
      }
    } catch {
        // ……省略异常处理
    }

    if (tasks.size > 0) {
      //……省略若干无关代码
      // 提交任务，taskScheduler只有一种实现：TaskSchedulerImpl
      // 提交后会生成一个TaskManager，处理一些任务冲突和资源问题
      // 之后挂进 SchedulableBuilder 的Pool里，这个SchedulableBuilder 是 TaskScheduler 初始化的时候生成用来管理Task的，
      // 有两个我们耳熟能详的调度实现：
      // FIFOSchedulableBuilder 和 FairSchedulableBuilder，
      // 任务如何调度取决于配置文件里配了哪一种方案，会在实际初始化 TaskSchedulerImpl 的时候生成哪一个Builder
      // 之后通过 SchedulerBackend 提交给任务池队列里，同时用 reviveOffers 唤醒 SchedulerBackend，
      // 实际上就是发条消息给 RpcEndpoint （实现类NettyRpcEndpointRef）
      // 这里多插一句，schedulerBackend 的实现类有2种，CoarseGrainedSchedulerBackend 和 LocalSchedulerBackend
      // 顾名思义，后者就是本地模式采用的，这里用了testSuit，所以启动的也是 LocalSchedulerBackend
      // 收到消息的RpcEndpoint会直接扔给postOneWayMessage（远程RPC会扔给 postToOutbox）
      // 后面都是远程消息处理部分，下一篇详细研究，简单说就是投递给endpoint相对应的Inbox，
      // 在Inbox里处理消息，转回给endpoint的receive函数进行处理（当然有些别的，此处不赘述），
      // 其实就是转了一圈又回到了 LocalSchedulerBackend 这里。
      // 而 LocalSchedulerBackend 的 receive 函数对 ReviveOffers 消息用的是 ReviveOffers() 进行处理。
      
      taskScheduler.submitTasks(new TaskSet(
        tasks.toArray, stage.id, stage.latestInfo.attemptNumber, jobId, properties))
    } else {
     
     // ……省略若干stage完成后处理工作
    }
```

实际 `LocalSchedulerBackend` 调用 `executor` 的地方在这里：
所以你可以看到，如果用的是 `local[*]` 的模式，这个 `executor` 是启动 `endpoint`时候直接 new 出来的，
下面代码里的 `localexecutorid` 一直都是 `driver`（因为没别的类型的execuror了）
在 `launchTask` 函数之后就没什么特殊之处了，
构建一个 TaskRunner 的任务封装（这个类的 `run` 函数超复杂，
想象一下它要完成反序列化任务，进行实际的计算等等）
然后调用 executor 的线程池开始执行。

```scala
 private val executor = new Executor(
    localexecutorid, localExecutorHostname, SparkEnv.get, userClassPath, isLocal = true)
  // …… 省略其他代码
  def reviveOffers() {
    val offers = IndexedSeq(new WorkerOffer(localExecutorId, localExecutorHostname, freeCores,
      Some(rpcEnv.address.hostPort)))
    for (task <- scheduler.resourceOffers(offers).flatten) {
      freeCores -= scheduler.CPUS_PER_TASK
      executor.launchTask(executorBackend, task)
    }
  }
```

其实任务执行的时候`executor` 还会有个 `reportHeartBeat` 发送一个心跳消息，去上报状态，
而全局的 `NettyRpcEnv` 也会有个 `ask` 函数定期去获取状态。

。。。总算写完了，好累。。。

~~凡Spark任务执行，驰车千驷，革车千乘，带甲十万，千里馈粮。~~
~~则内外之费，宾客之用，胶漆之材，车甲之奉，日费千金，然后十万之师举矣~~

说个鬼故事：
这才只是local[*]

---
参考：

1. [为啥key不能是array？](https://stackoverflow.com/questions/9973596/arraylist-as-key-in-hashmap)
2. 调试Spark：
    {: diff}
    调试Spark需要拿出~~魔法~~调试这个万能工具了，不能不感叹Spark团队代码的优秀，
    为Spark代码提供了完整的测试用例，直接打开 `ShuffleSuite`，执行第一个。
    结果调试到一半的时候发现 `ParallelCollectionRDD` 的行为和 `HadoopRDD` 的行为不太一样，然后半途换了一下。
    如果是`ParallelCollectionRDD`，在生成 `taskBinaryBytes` 的时候会直接把数据都一起做序列化送出去，
    如果是`HadoopRDD`,则只会把URI和相关信息序列化送出去。

    ![avatar][debugsuit1]

[results1]:data:image/png;base64,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2Yohy/O7YzICVcR8Df+xxjrXtpzco23s6CY1BmB8/tR1qXmAWndaXqyFu/IbM1Z+dOUv94dwjUgzD83qgQakIb9HE1yXRERERPQ93NXTxlYectzQYAW+bv6QVuuzZW93cFWOvJb2wfawYsy9D5vjhmvgyuap3cjhOHv6giV6NSKGZiLWEM6r4QnxMwClg9t47GPXvl09fQs7MJ01osoN8qqAB9oKWESq3EPRN75AcVxJLtt5SJ5M2lZt9AAAIABJREFUu+QrxCyH2/h2ud2Rllh/0tvP1zo4ATR/QUqEgPWoHTZYnudWnp/TTkz8QBnRPCDbtMtWo1m2OoQC8nBvG0VYAql0KLr7uCriZ+jNs1v5Mfh3RiPWS0D+tsPGunDzNeLd6TLw92j065KIiIiIvpOa2xs26+qiLmpn3xm+r0V6PhOpfS21fXcafbEZXwyIo62l9rXfuNrMIM5Pnes3P4fJt19Rnrlx48aNGzdu3Lhx4/bbtgnmtKFBut42pUV8RQ+Ku1lIbSFz6x1wMuHqjdkjJIPFg0MWZqMZ+qP5dz6HOfgB5ZmIiIiIiH6dDzStN/TbWIdi47D7wUvLGl+g+KPTD3ej9/sF5ZmIiIiIiH4fNtoQEREREREREc3QJKtHERERERERERHRc9hoQ0REREREREQ0Q2y0ISIiIiIiIiKaITbaEBERERERERHNEBttiIiIiIiIiIhmiI02REREREREREQzxEYbIiIiIiIiIqIZYqMNEREREREREdEMsdGGiIiIiIiIiGiG2GhDRERERERERDRDbLQhIiIiIiIiIpohNtoQEREREREREc0QG22IiIiIiIiIiGaIjTZERERERERERDPERhsiIiIiIiIiohliow0RERERERER0Qyx0YaIiIiIiIiIaIbYaENERERERERENENstCEiIiIiIiIimiE22hARERERERERzRAbbYiIiIiIiIiIZoiNNkREREREREREM/Tf20IWga/s0R8U4SNA3xahmZhFuhi4TQG3DfD5K0MeK1wD6x1caWHav6QQUeURaYxojsxWHoInz9lauNLBicEYZcaIIC8tTFcUVRFXETG8IAVProHLczG+QFGay+9pxHo5cR7fiNskrIEtczgxh/KsivgZoA8Gzvx9LG4HFlILkHuEMGWEHjTy/WBUE5RnIiIiop+ufvdmfFH7Wmo7g7jM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

[debugsuit1]:data:image/png;base64,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ClaaamkxPd/L4DpO09csEBFprbXdxwzrILZtYZlG1UU+g6QREREBBSutYRokLBsLt2VT0IqItNSq7mMGif7CdwqTnawujYiISJ6CFRERERERaUtbN7oCIiIiIiIilShYERERERGRtlRx6uLSLmB3feTOupm8cPalZtVHREREREQEUMuKiIiIiIi0qfqLQu65xGNfvkwMgJt4+imTv33qplbXS0RERERENrn6wcrFLh5OdQEQu9/nsfs9UmfvYOJiq6smIiIiIiKbWUPdwGbObmOmVTUREREREREp0diYlT1vE2M7M2pVERERERGRFmsoWIlF3oSL23ipRZUREREREREpaihYuXPPWzC3XV3BRERERESk5RoKVp5+aiczH7lEak+rqiMiIiIiIpLX2JiVi108/M/b+diXX+AHEy/w2P1vtahaIiIiIiKy2dWfurjUnks89hdv8vQX7+JhDbIXEREREZEWaqhl5WP3XyZ2tktrrIiIiIiISMs1FKy8dPEmiLxZWM1eRERERESkdRpbFHJuO+x5mztbVBkREREREZGiBgfYb2OGN4lpNjAREREREWmxxhaF/Mjb6gImIiIiIiLrov5sYHsu8diXLxeClJt4+ilTA+xFRERERKTl6gcrF7t4ONW1DlURERERERFZ0tiYFRERERERkXWiYEVERERERNrSlt1777mx0ZUQERERERFZTi0rIiIiIiLSlhSsiIiIiIhIW1KwIiIiIiIibUnBioiIiIiItCUFKyIiIiIi0pYUrIiIiIiISFtSsCIiIiIiIm1JwYpSLbwVAAAAhUlEQVSIiIiIiLQlBSsiIiIiItKWFKyIiIiIiEhbUrAiIiIiIiJtScGKiIiIiIi0JQUrIiIiIiLSlhSsiIiIiIhIW1KwIiIiIiIibUnBioiIiIiItCUFKyIiIiIi0pYUrIiIiIiISFtSsCIiIiIiIm1JwYqIiIiIiLQlBSsiIiIiItKW/h9qjXrh/jZC4QAAAABJRU5ErkJggg==