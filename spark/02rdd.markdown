---
permalink: /spark/rdd
layout: default
---
## RDD构造

来，先俗套一下

### 问题

- [RDD构造](#rdd构造)
  - [问题](#问题)
  - [什么是RDD？](#什么是rdd)
  - [RDD的创建过程](#rdd的创建过程)
  - [RDD的转换过程](#rdd的转换过程)

### 什么是RDD？

1. 什么是RDD？ 按官方文档的定义，[RDD](https://spark.apache.org/docs/latest/rdd-programming-guide.html) is a resilient distributed dataset，
所谓“弹性分布式数据集
2. RDD 代码位于 `org.apache.spark.rdd.RDD`，本身是个抽象类，RDD三个最重要属性是 **immutable（不可变）**、**partitioned（分区）**、**can be operated on in parallel（可被并行操作）**。
3. 抽象类RDD定义了一些必须实现的方法，例如`map`,`filter`,`presist`等等。
4. 任意一个RDD都应当具有以下**五个**基本特性：
   1. {: #five-1}可分区性，包含一个分区(原文**patition**)列表(我总觉得2.x以后提到分片（**split/slices**）和分区（**partition**）的时候有点微妙的区别,因为`map`操作之后的RDD从`MapRdd`变成了`MapPartitionsRDD`)
   2. {: #five-2}计算每一个分片(你看，来了吧，原文用的是**split**)的compute方法（有趣的是compute的参数之一split的类型是Partition）
   3. {: #five-3}一个依赖其他RDD的列表（RDD血缘关系）
   4. {: #five-4}*（可选）*一个针对(key,value)类RDD的分区器(**Partitioner**)，(例如hash-partitioned RDD，用hash作为分区方案)
   5. {: #five-5}*（可选）*记录首选对分片执行计算的位置列表(感觉这个特性主要还是为了在HDFS上执行计算而进行的)
5. RDD的创建方式：[There are two ways to create RDDs: parallelizing an existing collection in your driver program, or referencing a dataset in an external storage system, such as a shared filesystem, HDFS, HBase, or any data source offering a Hadoop InputFormat.](https://spark.apache.org/docs/latest/rdd-programming-guide.html#resilient-distributed-datasets-rdds) 除了new 一个 RDD 之外的主要途径是用`SparkContext`提供的`parallelize`方法把已存在的数据集转换为RDD，或者读取符合Hadoop InputFormat的数据集（多数情况下用这个）。

### RDD的创建过程

为了搞清楚RDD的创建过程，我们先来看一下这两种方法都做了什么（官方文档的2个生成例子)

1. `sc.parallelize`方法  

    该方法需要注意的有两点：
    1. Seq是可变集合（*mutiable*)的话，由于该方法是lazy的，如果实际执行之前改变了集合，则执行会按更新后的数据进行计算。
    2. 用`emptyRDD`和`parallelize(Seq[T]())`这样确定的类型T的方法去生成空RDD（注释里说的，原因没有说，试了一下，DAGScheduler报错了，目测应该是无具体类型的RDD无法生成DAG，如果带有类型的话，就会检测到`UnsupportedOperationException`，告诉你 `empty collection`。）
    方法就2行，检测sparkContext没有停止（感觉2.x之后很多方法执行之前都加了这个代码）,参数里有个默认分区数量，可以用 `spark.default.parallelism` 来指定。

    ```scala
      def parallelize[T: ClassTag](
          seq: Seq[T],
          numSlices: Int = defaultParallelism): RDD[T] = withScope {
        assertNotStopped()
        new ParallelCollectionRDD[T](this, seq, numSlices, Map[Int, Seq[String]]())
      }
    ```

    从 `ParallelCollectionRDD` 的声明中可以看到：

    ```scala
    private[spark] class ParallelCollectionRDD[T: ClassTag](
    sc: SparkContext,
    @transient private val data: Seq[T],
    numSlices: Int,
    locationPrefs: Map[Int, Seq[String]])
    extends RDD[T](sc, Nil)
    ```

    它继承的RDD构造器是没有deps的那个（抽象类RDD的构造方法是需要一个sparkContext，一个依赖列表`deps: Seq[Dependency[_]]`)，实际上也没有依赖，再往上就直接是scala collections（Seq）了。

    注意到它重载了父类RDD的`getPartions`方法：

    ```scala
    // 父类注释，本方法要求满足:
    // `rdd.partitions.zipWithIndex.forall { case (partition, index) => partition.index == index }`的对应表达式
    override def getPartitions: Array[Partition] = {
    // 调用伴生对象的slice方法获得Seq数据的切片列表，返回一个Seq[Seq[T]]的列表，其实就是把整个Seq的内容按numSlices切分为多段，
    // 当中有一些对Range和NumericRange对象的不同处理方式（不过slice内部方法position输出的是一个Iterator[(start:Int, end:Int)]
    // 所以有点奇怪numericRange处理的必要性。。。) 
    val slices = ParallelCollectionRDD.slice(data, numSlices).toArray
    // 真正完成分区操作的是返回一个 ParallelCollectionPartition（Partition的子类） 的Array[Partition]对象，
    // 到Partition层面就涉及spark对物理block的操作了，等看物理存储的时候再展开吧
    slices.indices.map(i => new ParallelCollectionPartition(id, i, slices(i))).toArray
    }
    ```

2. `val textRdd = sc.textFile("data.txt")`

    这个方法也是一样，位于`SparkContext`类：

    ```scala
    // 参数 minPartitions 同样跟着 `spark.default.parallelism` 
    def textFile(
      path: String,
      minPartitions: Int = defaultMinPartitions): RDD[String] = withScope {
    // 先判一下sc还活着吗？
    assertNotStopped()

    // 此处立刻调用了一个map,指定了路径、输入的类型[K,V]、（输出的）keyClass的类型、
    // （输出的）valueClass的类型，以及最小分区数量。
    // 参考下面hadoopFile的方法签名，去掉path，和minPartitions。加上inputFormatClass是个
    // InputFormat[K,V]，相当于输入是个[K Class,V Class]，加上keyClass和valueClass，这四个是不是很熟悉？
    // 想想Hadoop MapReduce过程，extends Mapper<输入key,输入的value,输出的key,输出的value>
    hadoopFile(path, classOf[TextInputFormat], classOf[LongWritable], classOf[Text],
      minPartitions).map(pair => pair._2.toString).setName(path)
    }
    ```

    接着看，`hadoopFile`也在`SparkContext`类里：

    ```scala
    // hadoopFile 的方法签名，指定了路径、输入的类型、Key的类型、Value的类型，以及最小分区数量
    def hadoopFile[K, V](
      path: String,
      inputFormatClass: Class[_ <: InputFormat[K, V]],
      keyClass: Class[K],
      valueClass: Class[V],
      minPartitions: Int = defaultMinPartitions): RDD[(K, V)] = withScope {
    // 惯例探测一下sc是不是还活着
    assertNotStopped()

    // This is a hack to enforce loading hdfs-site.xml.
    // See SPARK-11227 for details.
    FileSystem.getLocal(hadoopConfiguration)

    // A Hadoop configuration can be about 10 KB, which is pretty big, so broadcast it.
    // 把hadoopConfigration序列化，广播一下提高效率
    // 顺便一提，broadcast是个比较重的操作，从需要序列化就可以看出来，
    // RDD不能直接被广播，必须做完collect动作以后把实际内容广播出去。
    // broadcast是把值直接扔给broadcastManager，发送给全部node，所以要是实际物理大小太大的话就有点糟糕
    val confBroadcast = broadcast(new SerializableConfiguration(hadoopConfiguration))
    val setInputPathsFunc = (jobConf: JobConf) => FileInputFormat.setInputPaths(jobConf, path)
    new HadoopRDD(
      this,
      confBroadcast,
      Some(setInputPathsFunc),
      inputFormatClass,
      keyClass,
      valueClass,
      minPartitions).setName(path)
    }
    ```

    方法里新生成了一个`HadoopRDD`(`org.apache.spark.rdd.HadoopRDD`)返回，继续往下之前有2点值得注意：
        1. withScope方法，稍微Google了一下，主要是为了标示RDD操作的作用域，获取一些信息，方便DAG进行可视化，详情参考[这里](https://github.com/apache/spark/pull/5729#issuecomment-97207217)
        2. 强制加载 `hdfs-site.xml` 的hack，看了一下 [SPARK-11227](https://issues.apache.org/jira/browse/SPARK-11227)，是一个跟hadoop HA有关的bug，HA时取不到hostname的问题（**以后做相关开发的时候可能需要注意一下**）。

    然后我们下一节继续返回来看生成`HadoopRdd`之后的map操作。

### RDD的转换过程

上面我们看到了五个特性中的**可分区性**和**依赖列表**，接下来具体看一看RDD的转换过程。

回到`SparkContext`的`textFile`方法，接着刚才生成的`HadoopRDD`之后的map操作，`HadoopRDD`中并没有`overwrite` `map`方法，因此直接继承了RDD中的`map`方法。

```scala
  // 方法字面上的意思是要求传入一个将T转换为U的函数，最后返回一个类型为U的RDD
  def map[U: ClassTag](f: T => U): RDD[U] = withScope {
    // 好像以前没有clean这个东西，用来清除一些用不到的变量之类的，同时主动检查一下f能不能序列化
    val cleanF = sc.clean(f)
    // 定义了这样一个方法：入参是 this，(TaskContext, partition index, iterator) ，方法体是对迭代器进行map操作
    // 此处的map是scala 的 Iterator 对象的map
    new MapPartitionsRDD[U, T](this, (context, pid, iter) => iter.map(cleanF))
  }
```

{: #cleanf}
实际上入参就是把经过clean()的f方法二次封装成了（注意这个f的形式）

```scala
// 即从原始的：
f:T=>U 
// 变成了 f 分区执行版，注意这个map，它是 Iterator的方法，而不是RDD的方法：
f:(context:TaskContext,pid:Int,iter:Iterator[T]) =>  Iterator[T].map(cleanF) 
```

的形式，作为 MapPartitionsRDD的入参。 对照`MapPartitionsRDD` 的方法签名：

```scala
private[spark] class MapPartitionsRDD[U: ClassTag, T: ClassTag](
    var prev: RDD[T],
    f: (TaskContext, Int, Iterator[T]) => Iterator[U],  // (TaskContext, partition index, iterator)
    preservesPartitioning: Boolean = false,
    isFromBarrier: Boolean = false,
    isOrderSensitive: Boolean = false)
  extends RDD[U](prev)
```

|实参|形参|
|this|prev|
|(context,pid,iter)|f|
|----|----|
|f的实参|f的形参|
|context|TaskContext|
|pid|Int (partition index)|
|iter|Iterator[T]|

可以看到它继承了`RDD[U](prev)`的构造方法，而上面map方法中入参的 `this` 也就是 `HadoopRDD`，就是被`MapPartitionRDD`当作`prev`，
同时`f`的主要工作就是把一个T类型的迭代器 `Iterator[T]` 变换为一个U类型的迭代器 `Iterator[U]`。

{: #pred_deps}
此处划个重点，它继承的父类RDD构造器是下面这个：

```scala
  // MapPartitionsRDD 是个OneToOne的依赖，参考 Dependency 抽象类可以看到它继承了NarrowDependency，
  // 属于窄依赖的一种。
  def this(@transient oneParent: RDD[_]) =
    this(oneParent.context, List(new OneToOneDependency(oneParent)))
```

在生成新`MapPartitionRDD`的时候把前一个RDD的sc和前一个RDD的依赖关系传入了。

说到这里，有没有发现生成`MapPartitionsRDD`的时候只是重新封装了一个方法，
当时并没有`TaskContext`和`Partition.index`(作为`trait`的`Partition`有个声明为`Int`类型的`index`方法)，
有此疑问的话可以提前看看`MapPartitionRDD`里被重载`computer`方法，之前我们说了，
RDD其实是延迟计算的，所以这个时候只是在建立RDD之间的血缘关系，还没到实际计算的时候。

好，我们继续看下去，刚才我们说了，任意一个RDD，都应该有五个特征，我们万丈来看一下这个新生的`MapPartitionsRDD`的五个特征在哪里：

1. [可分区性](#five-1)：

    可分区性依然体现在`getPartitions`方法里，很简单，就一句，取了`firstParent`的分区：

    ```scala
      override def getPartitions: Array[Partition] = firstParent[T].partitions
    ```

    这个`firstParent`何许人也？我们回`RDD`去认识一下：

    ```scala
      /** Returns the first parent RDD */
    protected[spark] def firstParent[U: ClassTag]: RDD[U] = {
        dependencies.head.rdd.asInstanceOf[RDD[U]]
    }
    ```

    `dependencies`也是个方法：

    ```scala

    final def dependencies: Seq[Dependency[_]] = {
        // 会先从checkpoint里捞一下，如果没有的话就直接就再去dependencises_里捞一下
      checkpointRDD.map(r => List(new OneToOneDependency(r))).getOrElse {
        if (dependencies_ == null) {
            //dependencies_ 里也没有，实在捞不着的时候再用getDependencies挖一下
          dependencies_ = getDependencies
        }
        dependencies_
      }
    }
    ```

    而这个`getDependencies`也很有意思，就直接去取了 `deps`，是不是有点眼熟？[传送门](#pred_deps)

    ```scala
      protected def getDependencies: Seq[Dependency[_]] = deps
    ```

    所以对 `MapPartitionsRDD` 来说，`firstParent`就是依赖链列表里的第一个RDD，
    当时new的时候用的是`HadoopRDD`对吧？所以找到的这个firstParent就是`HadoopRdd`。

    通过上面的调用过程可以发现，`MapPartitionsRDD` 的分区列表的寻找其实是个方法的调用链，
    对当前RDD做 `getPartitions` 获取分区的操作，其实是通过一系列的方法套娃过程计算出来的
    （这是在没有生成`checkPointRDD`的情况下，有checkpointRDD的话会直接从当中某个阶段求起，
    这个下次单独挖`checkpoint()`方法的时候再说）:

    ```scala
    MapPartitionsRDD.getPartitions() {
        //
        MapPartitionsRDD.firstParent(){
            //
            MapPartitionsRDD.dependencies(){
                //一路调用链到此处，发现就是deps,参考过Dependency的实现就知道了，
                // 实际上Dependency就是rdd外面又套了个壳
                MapPartitionsRDD.getDependencies() 
            }
        }
    }
    ```

    所以我们可以得出一个这样的结论: `MapPartitionsRDD`的依赖列表里就只有一个元素，就是这个从上一个RDD生成的`Seq[Dependency[_]]`,
    不仅`MapPartitionsRDD`如此，采用此类构造器，没有`overwrite`过相关方法的RDD皆然，所以想见大部分RDD实现都是One2One的窄依赖。

    最后的`partitions` 就简单了，直接调用了返回的`HadoopRDD`的partitions方法，
    但实际上`HadoopRDD`里并没有overwrite这个方法，所以还是RDD本身的`partitions`方法：

    ```scala
    final def partitions: Array[Partition] = {
        checkpointRDD.map(_.partitions).getOrElse {
          if (partitions_ == null) {
            partitions_ = getPartitions //所以最后用的还是HadoopRDD的getPartitions方法
            partitions_.zipWithIndex.foreach { case (partition, index) =>
              require(partition.index == index,
                s"partitions($index).partition == ${partition.index}, but it should equal $index")
            }
          }
          partitions_
        }
      }
    ```

    `HadoopRDD`的`getPartitions`方法就不继续分析了，
    无非就是生成了一堆`HadoopPartition`，感觉以后挖分区机制和物理存储的时候再展开比较好。

2. [可用于计算的 `compute` 函数](#five-2)：

    `MapPartitionsRDD` 重载了这个方法，注意下面这个 `f` （[此处回忆杀](#cleanf)）：

    ```scala
      override def compute(split: Partition, context: TaskContext): Iterator[U] =
        f(context, split.index, firstParent[T].iterator(split, context))
    }
    ```

    你会发现RDD类里没有内置的Partition类型变量和TaskContext变量，这些都是计算时传入，到任务执行时候再执行。
    `firstParent`上一小节我们已经看过了，实际上它做了一个`f`方法套娃，
    把我们自定义`f`方法转换成了适合分布式执行的新`f`方法，
    注意这个方法是作用在**分区（Partition）**上，而非每一条数据上，
    简而言之这个`compute`的作用就是按`Task`+`Partition`的方式把自定义方法分配下去，
    而在`Partition`内部执行的时候，将会利用scala本身的并发特性，用`map`函数分配到每一条数据上。

    因此真正执行套娃函数的地方就是这个`compute`，注意入参最后一项，它用的是我们已经认识的`firstParent`的迭代器，
    在这个例子里是`HadoopRDD`（实际上`HadoopRDD`里并没有overwrite `iterator`方法，意即使用的是RDD的原始`iterator`方法:

    ```scala
          final def iterator(split: Partition, context: TaskContext): Iterator[T] = {
           if (storageLevel != StorageLevel.NONE) {
               //有cache拿cache，没cache直接算,实际上最后就是返回一个Iterator
             getOrCompute(split, context)
           } else {
               //从checkpoint里拿
             computeOrReadCheckpoint(split, context)
           }
         }
    ```

    实际上跟依赖列表类似，操作`compute`的时候是一层层迭代器套迭代器，然后一路返回。
    所以我们想象个栗子：如果在这个`textFile`方法(我们把里面2步标记为`new_hadoopRdd`和`mapRdd1.map(f1)`)，
    后面再套上一个`mapRdd2.map(f2)`函数，那么真正进行`compute`的时候,`mapRdd2`的`compute`会先找到依赖`mapRdd1`去执行`compute`，
    发现还要继续往前（回忆一下我们的老朋友`FirstParent`)，于是再往前得到`new_hadoopRDD`，
    执行`compute`，一路将迭代器返回：`new_hadoopRDD.compute() => mapRDD1.compute => mapRDD2.compute`
    `iterator`方法再往下就涉及到`org.apache.spark.storage.BlockResult` 部分，也即Spark的物理存储部分，本篇就不再深入了。

3. [RDD依赖列表（血缘关系）](#five-3)

    分析分区的时候仔细分析过了，是个长长的函数调用链套娃。

[4](#five-4)和[5](#five-5)的主题其实都比较大了，放到以后挖分区机制和物理存储的时候再看吧

---
依赖链可以动手验证一下：
`RDD.dependencies`，这几个都是公开函数。

```scala
  val textRdd = sc.textFile("data.txt")
  val mapRdd = textRdd.map(x=>x+"1")
  val map2Rdd = mapRdd.map(x=>x+"2")
  textRdd.dependencies
  mapRdd.dependencies
  map2Rdd.dependencies
```

结果：
![avatar][results]

---
后记：本篇花了一个多礼拜写完，感觉才刚刚挖了Spark这个怪物的冰山一角。
下一篇想写写Spark的基础框架，也就是spark用netty写的分布式框架内容，或者shuffle过程。

[results]:data:image/png;base64,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