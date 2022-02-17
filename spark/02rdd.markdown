---
permalink: /spark/rdd
layout: default
---
## RDD构造

来，先俗套一下

### 问题

1. 什么是RDD？
2. RDD转换过程？

### 什么是RDD？

1. 什么是RDD？ 按官方文档的定义，[RDD](https://spark.apache.org/docs/latest/rdd-programming-guide.html) is a resilient distributed dataset，
所谓“弹性分布式数据集
2. RDD 代码位于 `org.apache.spark.rdd.RDD`，本身是个抽象类，RDD三个最重要属性是 **immutable（不可变）**、**partitioned（分区）**、**can be operated on in parallel（可被并行操作）**。
3. 抽象类RDD定义了一些必须实现的方法，例如`map`,`filter`,`presist`等等。
4. 任意一个RDD都应当具有以下**五个**基本特性：
   1. 一个分区(原文**patition**)列表(我总觉得2.x以后提到分片（**split/slices*）和分区（**partition**）的时候有点微妙的区别,因为`map`操作之后的RDD从`mapRdd`变成了`MapPartitionsRDD`)
   2. 计算每一个分片(原文**split**)的compute方法（有趣的是compute的参数之一split的类型是Partition）
   3. 一个依赖其他RDD的列表（血缘关系）
   4. *（可选）*一个针对(key,value)类RDD的分区器(**Partitioner**)，(例如hash-partitioned RDD，用hash作为分区方案)
   5. *（可选）*记录首选对分片执行计算的位置列表(感觉这个特性主要还是为了在HDFS上执行计算而进行的)
5. RDD的创建方式：[There are two ways to create RDDs: parallelizing an existing collection in your driver program, or referencing a dataset in an external storage system, such as a shared filesystem, HDFS, HBase, or any data source offering a Hadoop InputFormat.](https://spark.apache.org/docs/latest/rdd-programming-guide.html#resilient-distributed-datasets-rdds) 除了new 一个 RDD 之外的主要途径是用`SparkContext`提供的`parallelize`方法把已存在的数据集转换为RDD，或者读取符合Hadoop InputFormat的数据集（多数情况下用这个）。

### RDD的转换过程

为了搞清楚RDD的转换过程，我们先来看一下这两种方法都做了什么（官方文档的2个生成例子)

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

    它继承的RDD构造器是没有deps的那个（抽象类RDD的构造函数是需要一个sparkContext，一个依赖列表`deps: Seq[Dependency[_]]`)，实际上也没有依赖，再往上就直接是scala collections（Seq）了。

2. ```sc.textFile("data.txt")```
