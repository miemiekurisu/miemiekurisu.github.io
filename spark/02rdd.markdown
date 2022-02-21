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
    - [未完待续](#未完待续)

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
f = {(TaskContext,pid,iter) => iter.map(cleanF)} 
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

    // 因为 MapPartitionsRDD 没有 overwrite这个方法，而是直接用了父类RDD的方法
    // 所以 MapPartitionsRDD 是个OneToOne的依赖，参考 Dependency 抽象类可以看到它继承了NarrowDependency，
    // 属于窄依赖的一种。
    final def dependencies: Seq[Dependency[_]] = {
        // 会先从checkpoint里捞一下，如果没有的话就直接就再去dependencises_里捞一下
      checkpointRDD.map(r => List(new OneToOneDependency(r))).getOrElse {
        if (dependencies_ == null) {
          dependencies_ = getDependencies
        }
        dependencies_
      }
    }
    ```

    所以对 `MapPartitionsRDD` 来说，`firstParent`就是依赖链列表里的第一个RDD，它的分区只是去取了第一个依赖的分区。
    注意这个`dependencies`，下面说依赖链的时候还会说到
2. [可用于计算的 `compute` 函数](#five-2)：

    `MapPartitionsRDD` 重载了这个方法，注意下面这个 `f` （[此处回忆杀](#cleanf)）：

    ```scala
      override def compute(split: Partition, context: TaskContext): Iterator[U] =
        f(context, split.index, firstParent[T].iterator(split, context))
    }
    ```

    你会发现RDD类里没有内置的Partition类型变量和TaskContext变量，这些都是计算时传入，到任务执行时候再仔细看。
    `firstParent`上一小节我们已经看过了，实际上它做了如下这个动作：

3. [RDD依赖列表（血缘关系）](#five-3)

    所以 `firstParent[T].partitions`  奥秘在于。。。它是个长长的函数调用链

---
再加上几个RDD转换的例子进行进一步调试：

```scala
  val flatMapRdd = textRdd.flatMap(x=>Array(x._1,x._2))
  val mapRdd = flatMapRdd.map(x=>x+1)
```

#### 未完待续
