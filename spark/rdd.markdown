---
permalink: /spark/rdd
layout: default
---
## RDD构造

来，先俗套一下
### 问题：
1. 什么是RDD？
2. RDD转换过程？

### 什么是RDD？

1. 什么是RDD？ 按官方文档的定义，[RDD](https://spark.apache.org/docs/latest/rdd-programming-guide.html) is a resilient distributed dataset，
所谓“弹性分布式数据集
2. RDD的创建方式：[There are two ways to create RDDs: parallelizing an existing collection in your driver program, or referencing a dataset in an external storage system, such as a shared filesystem, HDFS, HBase, or any data source offering a Hadoop InputFormat.](https://spark.apache.org/docs/latest/rdd-programming-guide.html#resilient-distributed-datasets-rdds) 除了new 一个 RDD 之外的主要途径是用`SparkContext`提供的`parallelize`方法把已存在的数据集转换为RDD，或者读取符合Hadoop InputFormat的数据集（多数情况下用这个）。
3. RDD 代码位于 `org.apache.spark.rdd.RDD`，本身是个抽象类，RDD三个最重要属性是 **immutable（不可变）**、**partitioned（分区）**、**can be operated on in parallel（可被并行操作）**。
4. 抽象类RDD定义了一些必须实现的方法，例如`map`,`filter`,`presist`等等。
5. 任意一个RDD都应当具有以下**五个**基本特性：
   1. 一个分区(原文**patition**)列表(我总觉得2.x以后分片（**split**）和分区（**partition**）已经分开了,因为`map`操作之后的RDD从`mapRdd`变成了`MapPartitionsRDD`)
   2. 计算每一个分片(原文**split**)的compute方法
   3. 一个依赖其他RDD的列表（血缘关系）
   4. *（可选）*一个针对(key,value)类RDD的分区器(**Partitioner**)，(例如hash-partitioned RDD，用hash作为分区方案)
   5. *（可选）*记录首选对分片执行计算的位置列表(感觉这个特性主要还是为了在HDFS上执行计算而进行的)

### RDD的转换过程

为了搞清楚RDD的转换过程，我们先来看一下这两种方法都做了什么（官方文档的2个生成例子)

1. ```sc.parallelize```

2. ```sc.textFile("data.txt")```
